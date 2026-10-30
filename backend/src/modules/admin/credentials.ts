import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import { decrypt } from '../../shared/crypto.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { authorizeDocumentAccess, signDownloadToken } from '../credentials/documents.js';
import { CREDENTIAL_STATUSES, EFFECTIVE_STATUS_SQL, statusLabel } from '../credentials/labels.js';
import { transitionCredential } from '../credentials/status.js';
import { notifyUsers } from '../notifications/service.js';

const queueQuery = z.object({
  status: z.enum(CREDENTIAL_STATUSES).default('submitted'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  order: z.enum(['asc', 'desc']).default('asc'),
});
const idParams = z.object({ id: z.uuid() });
const statusBody = z.object({
  to: z.enum(['pending_review', 'verified', 'rejected', 'needs_more_information', 'unable_to_verify', 'revoked']),
  method: z.enum(['document_review', 'primary_source']).optional(),
  sourceReference: z.string().trim().max(500).optional(),
  reason: z.string().trim().min(3).max(2000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
});

/** Credential review for platform reviewers, mounted at /admin. All routes require credential-review permission + MFA session. */
export function adminCredentialRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  r.use(needAuth);
  const review = requirePlatformPermission('admin.credential_review');

  r.get('/credentials', review, async (req, res) => {
    const q = queueQuery.parse(req.query);
    const where = `WHERE c.status = $1`;
    const [countRow] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM credentials c ${where}`, [q.status]);
    const rows = await db.query(
      `SELECT c.id, c.kind, c.credential_type, c.jurisdiction, c.expiration_date, c.status, c.updated_at, u.full_name AS professional_name
         FROM credentials c JOIN professionals p ON p.id = c.professional_id JOIN users u ON u.id = p.user_id
        ${where} ORDER BY c.updated_at ${q.order}, c.id LIMIT $2 OFFSET $3`, [q.status, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ credentials: rows, page: q.page, pageSize: q.pageSize, total: Number(countRow?.n ?? 0) });
  });

  // Includes the decrypted credential number so the reviewer can check it against the issuing source; every view is audited.
  r.get('/credentials/:id', validate({ params: idParams }), review, async (req, res) => {
    const id = param(req, 'id');
    const [c] = await db.query<any>(
      `SELECT c.id, c.kind, c.credential_type, c.jurisdiction, c.issuing_authority, c.number_enc, c.issue_date, c.expiration_date,
              c.status, ${EFFECTIVE_STATUS_SQL} AS effective_status, c.verification_method, c.verification_reference, c.verified_at,
              u.full_name AS professional_name, pr.name AS profession
         FROM credentials c JOIN professionals p ON p.id = c.professional_id JOIN users u ON u.id = p.user_id
         JOIN professions pr ON pr.id = p.profession_id WHERE c.id = $1`, [id]);
    if (!c) throw new AppError('NOT_FOUND', 'Resource not found.');
    const documents = await db.query('SELECT id, original_name, content_type, size_bytes, scan_status, uploaded_at FROM credential_documents WHERE credential_id = $1 ORDER BY uploaded_at', [id]);
    const history = await db.query(
      `SELECT v.actor_kind, v.from_status, v.to_status, v.method, v.source_reference, v.reason, v.internal_note, v.created_at, u.email AS actor_email
         FROM credential_verifications v JOIN users u ON u.id = v.actor_user_id WHERE v.credential_id = $1 ORDER BY v.seq`, [id]);
    const { number_enc, ...rest } = c;
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.credential_viewed', targetType: 'credential', targetId: id, requestId: req.requestId });
    res.json({
      credential: { ...rest, number: number_enc ? decrypt(config.fieldKey, number_enc) : null, status_label: statusLabel(c.effective_status, c.verification_method) },
      documents, history,
    });
  });

  r.post('/credentials/:id/status', validate({ params: idParams, body: statusBody }), review, async (req, res) => {
    const b = req.body as z.infer<typeof statusBody>;
    const out = await transitionCredential(db, {
      credentialId: param(req, 'id'), to: b.to, actorKind: 'platform', actorUserId: req.auth!.userId,
      method: b.method, sourceReference: b.sourceReference, reason: b.reason, internalNote: b.internalNote, requestId: req.requestId,
    });
    if (out.status !== 'pending_review') {
      const [owner] = await db.query<{ user_id: string }>('SELECT user_id FROM professionals WHERE id = $1', [out.professionalId]);
      if (owner) {
        await notifyUsers(deps, [owner.user_id], {
          category: 'review_decisions', type: `credential.${out.status}`, title: `Credential review update: ${out.status.replace(/_/g, ' ')}`,
          body: b.reason ?? undefined, data: { credentialId: out.id },
        });
      }
    }
    res.json({ credential: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  r.post('/credential-documents/:id/access', validate({ params: idParams }), review, async (req, res) => {
    const { doc } = await authorizeDocumentAccess(db, req.auth!, param(req, 'id'));
    const { token, expiresAt } = signDownloadToken(config, { documentId: doc.id, userId: req.auth!.userId }, now());
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.credential_document_access_link', targetType: 'credential', targetId: doc.credential_id, requestId: req.requestId, metadata: { documentId: doc.id } });
    res.json({ url: `/api/v1/credential-documents/download?token=${token}`, expiresAt });
  });

  return r;
}

const manage = requirePlatformPermission('admin.taxonomy_manage');
const nameField = z.string().trim().min(2).max(120);

/** Taxonomy administration (professions and specialties), mounted at /admin/taxonomies. */
export function adminTaxonomyRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const log = (req: Parameters<RequestHandler>[0], action: string, id: string) =>
    audit(db, { actorUserId: req.auth!.userId, action, targetType: 'taxonomy', targetId: id, requestId: req.requestId });

  r.post('/professions', manage, validate({ body: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,19}$/), name: nameField }) }), async (req, res) => {
    const [row] = await db.query<{ id: string }>('INSERT INTO professions (code, name) VALUES ($1,$2) RETURNING id, code, name, active', [req.body.code, req.body.name]);
    await log(req, 'taxonomy.profession_created', row!.id);
    res.status(201).json({ profession: row });
  });
  r.patch('/professions/:id', manage, validate({ params: idParams, body: z.object({ name: nameField.optional(), active: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0) }), async (req, res) => {
    const [row] = await db.query(
      'UPDATE professions SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1 RETURNING id, code, name, active',
      [param(req, 'id'), req.body.name ?? null, req.body.active ?? null]);
    if (!row) throw new AppError('NOT_FOUND', 'Resource not found.');
    await log(req, 'taxonomy.profession_updated', param(req, 'id'));
    res.json({ profession: row });
  });
  r.post('/specialties', manage, validate({ body: z.object({ professionId: z.uuid(), name: nameField }) }), async (req, res) => {
    const [row] = await db.query<{ id: string }>('INSERT INTO specialties (profession_id, name) VALUES ($1,$2) RETURNING id, profession_id, name, active', [req.body.professionId, req.body.name]);
    await log(req, 'taxonomy.specialty_created', row!.id);
    res.status(201).json({ specialty: row });
  });
  r.patch('/specialties/:id', manage, validate({ params: idParams, body: z.object({ name: nameField.optional(), active: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0) }), async (req, res) => {
    const [row] = await db.query(
      'UPDATE specialties SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1 RETURNING id, profession_id, name, active',
      [param(req, 'id'), req.body.name ?? null, req.body.active ?? null]);
    if (!row) throw new AppError('NOT_FOUND', 'Resource not found.');
    await log(req, 'taxonomy.specialty_updated', param(req, 'id'));
    res.json({ specialty: row });
  });
  return r;
}

/** Read-only taxonomy for signed-in users (profile forms), mounted at /taxonomies. */
export function taxonomyReadRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const r = Router();
  r.get('/professions', needAuth, async (_req, res) => {
    const professions = await deps.db.query('SELECT id, code, name FROM professions WHERE active ORDER BY name');
    const specialties = await deps.db.query('SELECT id, profession_id, name FROM specialties WHERE active ORDER BY name');
    res.json({ professions: professions.map((p: any) => ({ ...p, specialties: specialties.filter((s: any) => s.profession_id === p.id) })) });
  });
  return r;
}
