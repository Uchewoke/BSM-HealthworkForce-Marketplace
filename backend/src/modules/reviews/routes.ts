import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { requireOrgPermission, requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { notifyUsers } from '../notifications/service.js';
import { loadProfessional } from '../professionals/service.js';
import { REVIEW_WINDOW_DAYS, VISIBLE_SQL, organizationRating, professionalRating, reliability } from './service.js';

const idParams = z.object({ id: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });
const orgIdParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const reviewBody = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().min(3).max(1500).optional() });
const disputeBody = z.object({ reason: z.string().trim().min(10).max(1500) });
const resolveBody = z.object({ outcome: z.enum(['uphold', 'remove']), note: z.string().trim().min(3).max(1500) });
const queueQuery = z.object({
  status: z.enum(['open', 'upheld', 'removed']).default('open'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

type Direction = 'facility_to_professional' | 'professional_to_facility';

/**
 * Creates a review for one completed assignment with an approved timesheet. `scope` pins the author to their own
 * side of the assignment, so nobody can review work they were not part of.
 */
async function createReview(db: AppDeps['db'], now: Date, input: {
  assignmentId: string; direction: Direction; scope: { organizationId?: string; professionalId?: string };
  userId: string; rating: number; comment?: string; requestId: string;
}) {
  return db.transaction(async (tx) => {
    const [a] = await tx.query<{ id: string; status: string; organization_id: string; professional_id: string; reviewed_at: Date | null }>(
      `SELECT a.id, a.status, a.organization_id, a.professional_id, t.reviewed_at
         FROM assignments a LEFT JOIN timesheets t ON t.assignment_id = a.id AND t.status = 'approved'
        WHERE a.id = $1 AND ($2::uuid IS NULL OR a.organization_id = $2::uuid) AND ($3::uuid IS NULL OR a.professional_id = $3::uuid) FOR UPDATE OF a`,
      [input.assignmentId, input.scope.organizationId ?? null, input.scope.professionalId ?? null]);
    if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (a.status !== 'completed' || !a.reviewed_at) {
      throw new AppError('CONFLICT', 'Reviews can be written once the shift is completed and its hours have been approved.');
    }
    if (now.getTime() > new Date(a.reviewed_at).getTime() + REVIEW_WINDOW_DAYS * 86_400_000) {
      throw new AppError('CONFLICT', `The ${REVIEW_WINDOW_DAYS}-day window for reviewing this shift has closed.`);
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO reviews (assignment_id, direction, organization_id, professional_id, reviewer_user_id, rating, comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [a.id, input.direction, a.organization_id, a.professional_id, input.userId, input.rating, input.comment ?? null]);
    await audit(tx, { actorUserId: input.userId, action: 'review.created', targetType: 'review', targetId: row!.id, organizationId: a.organization_id, requestId: input.requestId, metadata: { direction: input.direction, rating: input.rating } });
    return { id: row!.id };
  });
}

async function createDispute(tx: Queryable, input: { reviewId: string; userId: string; reason: string; requestId: string; organizationId: string }) {
  const [d] = await tx.query<{ id: string }>('INSERT INTO review_disputes (review_id, raised_by, reason) VALUES ($1,$2,$3) RETURNING id', [input.reviewId, input.userId, input.reason]);
  await audit(tx, { actorUserId: input.userId, action: 'review.disputed', targetType: 'review', targetId: input.reviewId, organizationId: input.organizationId, requestId: input.requestId });
  return d!;
}

const DISPUTE_JOIN = `LEFT JOIN review_disputes d ON d.review_id = r.id`;

/** The professional's side, mounted at /professionals/me. */
export function professionalReviewRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router();

  r.get('/reviews', async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const toReview = await db.query(
      `SELECT a.id AS assignment_id, j.title, org.name AS organization_name, s.starts_at, t.reviewed_at + interval '${REVIEW_WINDOW_DAYS} days' AS review_until
         FROM assignments a JOIN timesheets t ON t.assignment_id = a.id AND t.status = 'approved' JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id
         JOIN organizations org ON org.id = a.organization_id
        WHERE a.professional_id = $1 AND a.status = 'completed' AND t.reviewed_at + interval '${REVIEW_WINDOW_DAYS} days' > $2
          AND NOT EXISTS (SELECT 1 FROM reviews x WHERE x.assignment_id = a.id AND x.direction = 'professional_to_facility')
        ORDER BY s.starts_at DESC LIMIT 50`, [p.id, now()]);
    const written = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, org.name AS organization_name FROM reviews r JOIN organizations org ON org.id = r.organization_id
        WHERE r.professional_id = $1 AND r.direction = 'professional_to_facility' ORDER BY r.created_at DESC LIMIT 100`, [p.id]);
    const received = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, org.name AS organization_name, d.status AS dispute_status
         FROM reviews r JOIN timesheets t ON t.assignment_id = r.assignment_id AND t.status = 'approved' JOIN organizations org ON org.id = r.organization_id ${DISPUTE_JOIN}
        WHERE r.professional_id = $1 AND r.direction = 'facility_to_professional' AND r.status = 'published' AND ${VISIBLE_SQL}
        ORDER BY r.created_at DESC LIMIT 100`, [p.id]);
    res.json({ toReview, written, received, rating: await professionalRating(db, p.id, true), reliability: await reliability(db, p.id), windowDays: REVIEW_WINDOW_DAYS });
  });

  r.post('/assignments/:id/review', validate({ params: idParams, body: reviewBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const out = await createReview(db, now(), { assignmentId: param(req, 'id'), direction: 'professional_to_facility', scope: { professionalId: p.id }, userId: req.auth!.userId, ...req.body, requestId: req.requestId });
    res.status(201).json({ review: out });
  });

  r.post('/reviews/:id/dispute', validate({ params: idParams, body: disputeBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const out = await db.transaction(async (tx) => {
      const [rev] = await tx.query<{ id: string; organization_id: string }>(
        `SELECT r.id, r.organization_id FROM reviews r JOIN timesheets t ON t.assignment_id = r.assignment_id AND t.status = 'approved'
          WHERE r.id = $1 AND r.professional_id = $2 AND r.direction = 'facility_to_professional' AND r.status = 'published' AND ${VISIBLE_SQL}`, [param(req, 'id'), p.id]);
      if (!rev) throw new AppError('NOT_FOUND', 'Resource not found.');
      return createDispute(tx, { reviewId: rev.id, userId: req.auth!.userId, reason: req.body.reason, requestId: req.requestId, organizationId: rev.organization_id });
    });
    res.status(201).json({ dispute: { id: out.id, status: 'open' } });
  });

  return r;
}

/** The facility's side, mounted at /organizations/:orgId. */
export function facilityReviewRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'applications.read');
  const manage = requireOrgPermission(deps, 'applications.manage');
  const orgOf = (req: Request) => req.membership!.organizationId;

  r.get('/ratings', validate({ params: orgParams }), read, async (req, res) => {
    const org = orgOf(req);
    const toReview = await db.query(
      `SELECT a.id AS assignment_id, j.title, u.full_name AS professional_name, s.starts_at, t.reviewed_at + interval '${REVIEW_WINDOW_DAYS} days' AS review_until
         FROM assignments a JOIN timesheets t ON t.assignment_id = a.id AND t.status = 'approved' JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id
         JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id
        WHERE a.organization_id = $1 AND a.status = 'completed' AND t.reviewed_at + interval '${REVIEW_WINDOW_DAYS} days' > $2
          AND NOT EXISTS (SELECT 1 FROM reviews x WHERE x.assignment_id = a.id AND x.direction = 'facility_to_professional')
        ORDER BY s.starts_at DESC LIMIT 50`, [org, now()]);
    const written = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS professional_name FROM reviews r JOIN professionals p ON p.id = r.professional_id JOIN users u ON u.id = p.user_id
        WHERE r.organization_id = $1 AND r.direction = 'facility_to_professional' ORDER BY r.created_at DESC LIMIT 100`, [org]);
    // Professionals review anonymously: the facility sees the rating and comment, never who wrote it.
    const received = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, d.status AS dispute_status
         FROM reviews r JOIN timesheets t ON t.assignment_id = r.assignment_id AND t.status = 'approved' ${DISPUTE_JOIN}
        WHERE r.organization_id = $1 AND r.direction = 'professional_to_facility' AND r.status = 'published' AND ${VISIBLE_SQL}
        ORDER BY r.created_at DESC LIMIT 100`, [org]);
    res.json({ toReview, written, received, rating: await organizationRating(db, org, true), windowDays: REVIEW_WINDOW_DAYS });
  });

  r.post('/assignments/:id/review', validate({ params: orgIdParams, body: reviewBody }), manage, async (req, res) => {
    const out = await createReview(db, now(), { assignmentId: param(req, 'id'), direction: 'facility_to_professional', scope: { organizationId: orgOf(req) }, userId: req.auth!.userId, ...req.body, requestId: req.requestId });
    res.status(201).json({ review: out });
  });

  r.post('/reviews/:id/dispute', validate({ params: orgIdParams, body: disputeBody }), manage, async (req, res) => {
    const out = await db.transaction(async (tx) => {
      const [rev] = await tx.query<{ id: string }>(
        `SELECT r.id FROM reviews r JOIN timesheets t ON t.assignment_id = r.assignment_id AND t.status = 'approved'
          WHERE r.id = $1 AND r.organization_id = $2 AND r.direction = 'professional_to_facility' AND r.status = 'published' AND ${VISIBLE_SQL}`, [param(req, 'id'), orgOf(req)]);
      if (!rev) throw new AppError('NOT_FOUND', 'Resource not found.');
      return createDispute(tx, { reviewId: rev.id, userId: req.auth!.userId, reason: req.body.reason, requestId: req.requestId, organizationId: orgOf(req) });
    });
    res.status(201).json({ dispute: { id: out.id, status: 'open' } });
  });

  return r;
}

/** Staff dispute handling, mounted at /admin/reviews. Resolving never edits a review: it either stands or is removed. */
export function adminReviewRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const support = requirePlatformPermission('admin.support');

  r.get('/disputes', support, async (req, res) => {
    const q = queueQuery.parse(req.query);
    const [count] = await db.query<{ n: string }>('SELECT count(*) AS n FROM review_disputes WHERE status = $1', [q.status]);
    const rows = await db.query(
      `SELECT d.id, d.status, d.reason, d.created_at, d.resolution_note, d.resolved_at, r.id AS review_id, r.direction, r.rating, r.comment,
              org.name AS organization_name, u.full_name AS professional_name
         FROM review_disputes d JOIN reviews r ON r.id = d.review_id JOIN organizations org ON org.id = r.organization_id
         JOIN professionals p ON p.id = r.professional_id JOIN users u ON u.id = p.user_id
        WHERE d.status = $1 ORDER BY d.created_at, d.id LIMIT $2 OFFSET $3`, [q.status, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ disputes: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.post('/disputes/:id/resolve', validate({ params: idParams, body: resolveBody }), support, async (req, res) => {
    const b = req.body as z.infer<typeof resolveBody>;
    const out = await db.transaction(async (tx) => {
      const [d] = await tx.query<{ id: string; status: string; review_id: string; raised_by: string }>('SELECT id, status, review_id, raised_by FROM review_disputes WHERE id = $1 FOR UPDATE', [param(req, 'id')]);
      if (!d) throw new AppError('NOT_FOUND', 'Resource not found.');
      if (d.status !== 'open') throw new AppError('CONFLICT', `This dispute was already resolved (${d.status}).`);
      const remove = b.outcome === 'remove';
      await tx.query(`UPDATE review_disputes SET status = $2, resolved_by = $3, resolution_note = $4, resolved_at = now() WHERE id = $1`, [d.id, remove ? 'removed' : 'upheld', req.auth!.userId, b.note]);
      if (remove) await tx.query(`UPDATE reviews SET status = 'removed' WHERE id = $1`, [d.review_id]);
      await audit(tx, { actorUserId: req.auth!.userId, action: `review.dispute_${remove ? 'removed' : 'upheld'}`, targetType: 'review', targetId: d.review_id, requestId: req.requestId, metadata: { disputeId: d.id } });
      return { remove, raisedBy: d.raised_by };
    });
    await notifyUsers(deps, [out.raisedBy], {
      category: 'review_decisions', type: `review.dispute_${out.remove ? 'removed' : 'upheld'}`,
      title: out.remove ? 'Your dispute was accepted: the review was removed' : 'Your dispute was reviewed: the review stands', body: b.note,
    });
    res.json({ dispute: { id: param(req, 'id'), status: out.remove ? 'removed' : 'upheld' } });
  });

  return r;
}
