import { randomUUID, createHash } from 'node:crypto';
import express, { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { param, validate } from '../../middleware/http.js';
import { encrypt } from '../../shared/crypto.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { buildSet } from '../../shared/sql.js';
import { audit } from '../audit/service.js';
import { isoDate, stateCode } from '../professionals/schemas.js';
import { loadProfessional } from '../professionals/service.js';
import {
  ALLOWED_TYPES, MAX_DOCUMENTS_PER_CREDENTIAL, MAX_UPLOAD_BYTES, authorizeDocumentAccess, contentMatchesType,
  sanitizeFileName, signDownloadToken, verifyDownloadToken,
} from './documents.js';
import { CREDENTIAL_PUBLIC_COLUMNS, withLabel } from './labels.js';
import { EDITABLE_STATUSES, transitionCredential } from './status.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const credentialBase = z.object({
  kind: z.enum(['license', 'certification']),
  credentialType: text(80),
  jurisdiction: stateCode.optional(),
  issuingAuthority: text(200).optional(),
  number: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9\-/ .]+$/, 'Letters, digits and - / . only').optional(),
  issueDate: isoDate.optional(),
  expirationDate: isoDate.optional(),
});
export const credentialBody = credentialBase
  .refine((b) => b.kind !== 'license' || !!b.jurisdiction, { message: 'A license requires a jurisdiction (state).', path: ['jurisdiction'] })
  .refine((b) => !b.issueDate || !b.expirationDate || b.expirationDate >= b.issueDate, { message: 'expirationDate must not precede issueDate', path: ['expirationDate'] });
const credentialPatch = credentialBase.omit({ kind: true }).partial().refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');

const COLUMNS = { credentialType: 'credential_type', jurisdiction: 'jurisdiction', issuingAuthority: 'issuing_authority', issueDate: 'issue_date', expirationDate: 'expiration_date' };
const MAX_CREDENTIALS = 30;
const idParams = z.object({ id: z.uuid() });
const docParams = z.object({ id: z.uuid(), docId: z.uuid() });
const DOC_COLUMNS = 'id, original_name, content_type, size_bytes, scan_status, uploaded_at';

/** Professional's own credentials, mounted at /professionals/me/credentials. */
export function credentialRoutes(deps: AppDeps) {
  const { db, config, storage, scanner } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  const me = (req: Request) => loadProfessional(db, req.auth!.userId);
  const log = (req: Request, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit(db, { actorUserId: req.auth!.userId, action, targetType: 'credential', targetId: id, requestId: req.requestId, metadata });
  const notFound = () => new AppError('NOT_FOUND', 'Resource not found.');

  /** Loads one of the caller's own credentials (404 for anyone else's). */
  async function own(req: Request, id: string) {
    const p = await me(req);
    const [c] = await db.query<{ id: string; status: string }>('SELECT id, status FROM credentials WHERE id = $1 AND professional_id = $2', [id, p.id]);
    if (!c) throw notFound();
    return { p, c };
  }
  const requireEditable = (status: string) => {
    if (!(EDITABLE_STATUSES as string[]).includes(status)) {
      throw new AppError('CONFLICT', 'This credential can no longer be edited in its current review status.', { credentialStatus: status });
    }
  };

  r.get('/', async (req, res) => {
    const p = await me(req);
    const rows = await db.query<any>(`SELECT ${CREDENTIAL_PUBLIC_COLUMNS} FROM credentials c WHERE c.professional_id = $1 ORDER BY c.created_at`, [p.id]);
    res.json({ credentials: rows.map(withLabel) });
  });

  r.post('/', validate({ body: credentialBody }), async (req, res) => {
    const p = await me(req);
    const b = req.body as z.infer<typeof credentialBody>;
    const [{ n } = { n: '0' }] = await db.query<{ n: string }>('SELECT count(*) AS n FROM credentials WHERE professional_id = $1', [p.id]);
    if (Number(n) >= MAX_CREDENTIALS) throw new AppError('CONFLICT', `You can add at most ${MAX_CREDENTIALS} credentials.`);
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO credentials (professional_id, kind, credential_type, jurisdiction, issuing_authority, number_enc, number_last4, issue_date, expiration_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.id, b.kind, b.credentialType, b.jurisdiction ?? null, b.issuingAuthority ?? null,
       b.number ? encrypt(config.fieldKey, b.number) : null, b.number ? b.number.slice(-4) : null, b.issueDate ?? null, b.expirationDate ?? null]);
    await log(req, 'credential.created', row!.id, { kind: b.kind });
    const [c] = await db.query<any>(`SELECT ${CREDENTIAL_PUBLIC_COLUMNS} FROM credentials c WHERE c.id = $1`, [row!.id]);
    res.status(201).json({ credential: withLabel(c) });
  });

  r.get('/:id', validate({ params: idParams }), async (req, res) => {
    const { c } = await own(req, param(req, 'id'));
    const [row] = await db.query<any>(`SELECT ${CREDENTIAL_PUBLIC_COLUMNS} FROM credentials c WHERE c.id = $1`, [c.id]);
    const documents = await db.query(`SELECT ${DOC_COLUMNS} FROM credential_documents WHERE credential_id = $1 ORDER BY uploaded_at`, [c.id]);
    const history = await db.query(
      `SELECT actor_kind, from_status, to_status, method, reason, created_at FROM credential_verifications WHERE credential_id = $1 ORDER BY seq`, [c.id]);
    res.json({ credential: withLabel(row), documents, history });
  });

  r.patch('/:id', validate({ params: idParams, body: credentialPatch }), async (req, res) => {
    const { c } = await own(req, param(req, 'id'));
    requireEditable(c.status);
    const b = req.body as z.infer<typeof credentialPatch>;
    const set = buildSet(COLUMNS, b, 2);
    const extra: string[] = [];
    const values: unknown[] = set ? [...set.values] : [];
    if (b.number) {
      extra.push(`number_enc = $${values.length + 2}`, `number_last4 = $${values.length + 3}`);
      values.push(encrypt(config.fieldKey, b.number), b.number.slice(-4));
    }
    const sets = [set?.sql, ...extra].filter(Boolean).join(', ');
    await db.query(`UPDATE credentials SET ${sets}, updated_at = now() WHERE id = $1`, [c.id, ...values]); // DB CHECKs backstop date order
    await log(req, 'credential.updated', c.id, { fields: Object.keys(b) });
    const [row] = await db.query<any>(`SELECT ${CREDENTIAL_PUBLIC_COLUMNS} FROM credentials c WHERE c.id = $1`, [c.id]);
    res.json({ credential: withLabel(row) });
  });

  r.delete('/:id', validate({ params: idParams }), async (req, res) => {
    const { c } = await own(req, param(req, 'id'));
    if (c.status !== 'not_submitted') throw new AppError('CONFLICT', 'Only credentials that were never submitted can be deleted.');
    const docs = await db.query<{ storage_key: string }>('SELECT storage_key FROM credential_documents WHERE credential_id = $1', [c.id]);
    await db.query('DELETE FROM credentials WHERE id = $1', [c.id]);
    for (const d of docs) await storage.delete(d.storage_key);
    await log(req, 'credential.deleted', c.id);
    res.status(204).end();
  });

  r.post('/:id/submit', validate({ params: idParams }), async (req, res) => {
    const { p, c } = await own(req, param(req, 'id'));
    const out = await transitionCredential(db, { credentialId: c.id, to: 'submitted', actorKind: 'professional', actorUserId: req.auth!.userId, professionalId: p.id, requestId: req.requestId });
    res.json({ credential: { id: out.id, status: out.status } });
  });

  // ---- documents (private storage)
  r.get('/:id/documents', validate({ params: idParams }), async (req, res) => {
    const { c } = await own(req, param(req, 'id'));
    res.json({ documents: await db.query(`SELECT ${DOC_COLUMNS} FROM credential_documents WHERE credential_id = $1 ORDER BY uploaded_at`, [c.id]) });
  });

  const rawUpload: RequestHandler = express.raw({ type: [...ALLOWED_TYPES], limit: MAX_UPLOAD_BYTES });
  r.post('/:id/documents', validate({ params: idParams }), rawUpload, async (req, res) => {
    const { p, c } = await own(req, param(req, 'id'));
    requireEditable(c.status);
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const bytes = req.body as unknown;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Send the file as the raw request body with Content-Type ${ALLOWED_TYPES.join(', ')}.`);
    }
    if (!contentMatchesType(bytes, type)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The file content does not match an allowed document type (PDF, JPEG, PNG).');
    const [{ n } = { n: '0' }] = await db.query<{ n: string }>('SELECT count(*) AS n FROM credential_documents WHERE credential_id = $1', [c.id]);
    if (Number(n) >= MAX_DOCUMENTS_PER_CREDENTIAL) throw new AppError('CONFLICT', `At most ${MAX_DOCUMENTS_PER_CREDENTIAL} documents per credential.`);

    const scan = await scanner.scan(bytes);
    if (scan === 'infected') {
      await log(req, 'credential_document.rejected_malware', c.id);
      throw new AppError('VALIDATION_FAILED', 'This file was rejected by the security scan.');
    }
    const storageKey = randomUUID();
    await storage.put(storageKey, bytes);
    try {
      const [doc] = await db.query<{ id: string }>(
        `INSERT INTO credential_documents (credential_id, professional_id, storage_key, original_name, content_type, size_bytes, sha256, scan_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${DOC_COLUMNS}`,
        [c.id, p.id, storageKey, sanitizeFileName(req.headers['x-file-name'] as string | undefined), type, bytes.length,
         createHash('sha256').update(bytes).digest('hex'), scan === 'clean' ? 'clean' : 'not_scanned']);
      await log(req, 'credential_document.uploaded', c.id, { bytes: bytes.length, type, scan });
      res.status(201).json({ document: doc });
    } catch (e) {
      await storage.delete(storageKey);
      throw e;
    }
  });

  r.delete('/:id/documents/:docId', validate({ params: docParams }), async (req, res) => {
    const { c } = await own(req, param(req, 'id'));
    requireEditable(c.status);
    const rows = await db.query<{ storage_key: string }>('DELETE FROM credential_documents WHERE id = $1 AND credential_id = $2 RETURNING storage_key', [param(req, 'docId'), c.id]);
    if (!rows[0]) throw notFound();
    await storage.delete(rows[0].storage_key);
    await log(req, 'credential_document.deleted', c.id);
    res.status(204).end();
  });

  r.post('/:id/documents/:docId/access', validate({ params: docParams }), async (req, res) => {
    const { c } = await own(req, param(req, 'id'));
    const [d] = await db.query<{ id: string }>('SELECT id FROM credential_documents WHERE id = $1 AND credential_id = $2', [param(req, 'docId'), c.id]);
    if (!d) throw notFound();
    const { token, expiresAt } = signDownloadToken(config, { documentId: d.id, userId: req.auth!.userId }, now());
    await log(req, 'credential_document.access_link_created', c.id);
    res.json({ url: `/api/v1/credential-documents/download?token=${token}`, expiresAt });
  });

  return r;
}

/** Streams a document for a valid, short-lived, user-bound link. Authorization is re-checked on every download. */
export function documentDownloadRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db, config, storage } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  r.get('/download', needAuth, async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const t = verifyDownloadToken(config, token, now());
    if (t.userId !== req.auth!.userId) throw new AppError('FORBIDDEN', 'This download link is invalid or has expired.');
    const { doc, asReviewer } = await authorizeDocumentAccess(db, req.auth!, t.documentId);
    const bytes = await storage.get(doc.storage_key);
    if (!bytes) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, {
      actorUserId: req.auth!.userId, action: 'credential_document.downloaded', targetType: 'credential', targetId: doc.credential_id,
      requestId: req.requestId, metadata: { documentId: doc.id, asReviewer },
    });
    res.setHeader('content-type', doc.content_type);
    res.setHeader('content-disposition', `attachment; filename="${sanitizeFileName(doc.original_name)}"`);
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.send(bytes);
  });
  return r;
}
