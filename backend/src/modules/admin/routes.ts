import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { emailSchema } from '../auth/schemas.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { ORG_STATUSES, transitionOrganization } from '../organizations/status.js';

const queueQuery = z.object({
  type: z.enum(['facility', 'agency']).default('facility'),
  status: z.enum(ORG_STATUSES).default('submitted'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(['created_at', 'updated_at']).default('updated_at'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
const orgParams = z.object({ orgId: z.uuid() });
const statusBody = z.object({
  to: z.enum(['under_review', 'approved', 'rejected', 'needs_information', 'suspended']),
  reason: z.string().trim().min(3).max(2000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
});

export function adminRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const review = requirePlatformPermission('admin.facility_review');

  // Explicit, audited platform access path to user records.
  r.get('/users/lookup', requirePlatformPermission('admin.user_lookup'), validate({ query: z.object({ email: emailSchema }) }), async (req, res) => {
    const email = emailSchema.parse(req.query.email);
    const [u] = await db.query<{ id: string }>(
      'SELECT id, email, full_name, status, email_verified_at, platform_role FROM users WHERE lower(email) = $1', [email]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.user_lookup', targetType: 'user', targetId: u?.id, requestId: req.requestId });
    res.json({ user: u ?? null });
  });

  // ---- facility review queue
  r.get('/organizations', review, async (req, res) => {
    const q = queueQuery.parse(req.query); // sort/order come from allowlisted enums
    const [countRow] = await db.query<{ count: string }>(`SELECT count(*) FROM organizations WHERE type = $1 AND status = $2`, [q.type, q.status]);
    const rows = await db.query(
      `SELECT id, name, legal_name, state, status, created_at, updated_at FROM organizations
        WHERE type = $1 AND status = $2 ORDER BY ${q.sort} ${q.order}, id LIMIT $3 OFFSET $4`,
      [q.type, q.status, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ organizations: rows, page: q.page, pageSize: q.pageSize, total: Number(countRow?.count ?? 0) });
  });

  r.get('/organizations/:orgId', validate({ params: orgParams }), review, async (req, res) => {
    const id = req.params.orgId as string;
    const [org] = await db.query('SELECT * FROM organizations WHERE id = $1', [id]);
    if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
    const members = await db.query(
      `SELECT m.id, m.role, u.email, u.full_name, u.email_verified_at FROM organization_members m
         JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.status = 'active' ORDER BY m.created_at`, [id]);
    const reviews = await db.query(
      `SELECT r.id, r.actor_kind, r.from_status, r.to_status, r.reason, r.internal_note, r.created_at, u.email AS actor_email
         FROM organization_reviews r JOIN users u ON u.id = r.actor_user_id WHERE r.organization_id = $1 ORDER BY r.created_at, r.id`, [id]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.organization_viewed', targetType: 'organization', targetId: id, organizationId: id, requestId: req.requestId });
    res.json({ organization: org, members, reviews });
  });

  r.post('/organizations/:orgId/status', validate({ params: orgParams, body: statusBody }), review, async (req, res) => {
    const out = await transitionOrganization(db, {
      orgId: req.params.orgId as string, to: req.body.to, actorKind: 'platform', actorUserId: req.auth!.userId,
      reason: req.body.reason, internalNote: req.body.internalNote, requestId: req.requestId,
    });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.id, 'org.update'), {
      category: 'review_decisions', type: `organization.${out.status}`, title: `Your organization review: ${out.status.replace(/_/g, ' ')}`,
      body: req.body.reason ?? undefined, data: { organizationId: out.id },
    });
    res.json({ organization: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  return r;
}
