import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { evaluateMatch } from '../matching/loader.js';
import { loadProfessional } from '../professionals/service.js';
import {
  ASSIGNMENT_STATUSES, OFFER_STATUSES, UNDO_WINDOW_MINUTES, createShiftOffer, expireOffers, respondToShiftOffer, statusText, transitionAssignment, withdrawShiftOffer,
} from './shift-offers-service.js';

const page = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
};
const offerListQuery = z.object({ status: z.enum(OFFER_STATUSES).optional(), applicationId: z.uuid().optional(), ...page });
const assignmentListQuery = z.object({ status: z.enum(ASSIGNMENT_STATUSES).optional(), ...page });
const idParams = z.object({ id: z.uuid() });
const orgAppParams = z.object({ orgId: z.uuid(), appId: z.uuid() });
const orgOfferParams = z.object({ orgId: z.uuid(), offerId: z.uuid() });
const orgIdParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const createOfferBody = z.object({
  shiftId: z.uuid(),
  hourlyRateCents: z.number().int().min(0).max(100_000).optional(),
  message: z.string().trim().max(2000).optional(),
  expiresInHours: z.number().int().min(1).max(168).optional(),
});
const respondBody = z.object({ response: z.enum(['accepted', 'declined']) });
const facilityAssignmentBody = z.object({
  to: z.enum(['completed', 'no_show', 'cancelled_by_facility']),
  reason: z.string().trim().min(3).max(2000).optional(),
});
const professionalCancelBody = z.object({ reason: z.string().trim().min(3).max(2000) });
const undoBody = z.object({ reason: z.string().trim().min(3).max(1000).optional() }).optional();

const OFFER_COLS = `o.id, o.status, o.hourly_rate_cents, o.message, o.expires_at, o.responded_at, o.created_at, o.application_id, o.shift_id,
  s.starts_at, s.ends_at, j.id AS job_id, j.title, l.city, l.state, l.timezone`;
const OFFER_FROM = `shift_offers o JOIN shifts s ON s.id = o.shift_id JOIN jobs j ON j.id = s.job_id JOIN facility_locations l ON l.id = j.location_id`;
const ASSIGNMENT_COLS = `a.id, a.status, a.hourly_rate_cents, a.created_at, a.updated_at, a.shift_id,
  s.starts_at, s.ends_at, j.id AS job_id, j.title, l.city, l.state, l.timezone`;
const ASSIGNMENT_FROM = `assignments a JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id JOIN facility_locations l ON l.id = j.location_id`;

/** Facility side, mounted at /organizations/:orgId. Every query is scoped by organization_id. */
export function shiftOfferFacilityRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'applications.read');
  const manage = requireOrgPermission(deps, 'applications.manage');
  const orgOf = (req: Request) => req.membership!.organizationId;
  const ownerUser = async (professionalId: string) =>
    (await db.query<{ user_id: string }>('SELECT user_id FROM professionals WHERE id = $1', [professionalId]))[0]?.user_id;

  r.post('/applications/:appId/shift-offers', validate({ params: orgAppParams, body: createOfferBody }), manage, async (req, res) => {
    const b = req.body as z.infer<typeof createOfferBody>;
    const out = await createShiftOffer(db, {
      organizationId: orgOf(req), applicationId: param(req, 'appId'), shiftId: b.shiftId, actorUserId: req.auth!.userId,
      hourlyRateCents: b.hourlyRateCents, message: b.message, expiresInHours: b.expiresInHours, requestId: req.requestId, now: now(),
    });
    const userId = await ownerUser(out.professionalId);
    if (userId) {
      await notifyUsers(deps, [userId], {
        category: 'application_updates', type: 'shift_offer.sent', title: `Shift offer: ${out.jobTitle}`,
        body: 'A facility offered you a shift. Review it before it expires.', data: { offerId: out.id, shiftId: out.shiftId },
      });
    }
    res.status(201).json({ offer: { id: out.id, status: out.status, expiresAt: out.expiresAt } });
  });

  r.get('/shift-offers', validate({ params: z.object({ orgId: z.uuid() }) }), read, async (req, res) => {
    await expireOffers(db, now());
    const q = offerListQuery.parse(req.query);
    const args: unknown[] = [orgOf(req)];
    let where = 'o.organization_id = $1';
    if (q.applicationId) { args.push(q.applicationId); where += ` AND o.application_id = $${args.length}`; }
    if (q.status) { args.push(q.status); where += ` AND o.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM shift_offers o WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${OFFER_COLS}, u.full_name AS professional_name FROM ${OFFER_FROM} JOIN professionals p ON p.id = o.professional_id JOIN users u ON u.id = p.user_id
        WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ offers: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.post('/shift-offers/:offerId/withdraw', validate({ params: orgOfferParams }), manage, async (req, res) => {
    const out = await withdrawShiftOffer(db, { organizationId: orgOf(req), offerId: param(req, 'offerId'), actorUserId: req.auth!.userId, requestId: req.requestId, now: now() });
    const userId = await ownerUser(out.professionalId);
    if (userId) {
      await notifyUsers(deps, [userId], {
        category: 'application_updates', type: 'shift_offer.withdrawn', title: 'A shift offer was withdrawn',
        body: 'The facility withdrew a shift offer.', data: { offerId: out.id },
      });
    }
    res.json({ offer: { id: out.id, status: out.status } });
  });

  r.get('/assignments', validate({ params: z.object({ orgId: z.uuid() }) }), read, async (req, res) => {
    const q = assignmentListQuery.parse(req.query);
    const args: unknown[] = [orgOf(req)];
    let where = 'a.organization_id = $1';
    if (q.status) { args.push(q.status); where += ` AND a.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM assignments a WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${ASSIGNMENT_COLS}, u.full_name AS professional_name FROM ${ASSIGNMENT_FROM} JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id
        WHERE ${where} ORDER BY s.starts_at DESC, a.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ assignments: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/assignments/:id', validate({ params: orgIdParams }), read, async (req, res) => {
    const [a] = await db.query<any>(
      `SELECT ${ASSIGNMENT_COLS}, u.full_name AS professional_name FROM ${ASSIGNMENT_FROM} JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id
        WHERE a.id = $1 AND a.organization_id = $2`, [param(req, 'id'), orgOf(req)]);
    if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
    const history = await db.query('SELECT actor_kind, from_status, to_status, reason, created_at FROM assignment_status_history WHERE assignment_id = $1 ORDER BY seq', [a.id]);
    res.json({ assignment: a, history });
  });

  r.post('/assignments/:id/status', validate({ params: orgIdParams, body: facilityAssignmentBody }), manage, async (req, res) => {
    const b = req.body as z.infer<typeof facilityAssignmentBody>;
    const out = await transitionAssignment(db, {
      assignmentId: param(req, 'id'), actorKind: 'organization', actorUserId: req.auth!.userId, organizationId: orgOf(req),
      to: b.to, reason: b.reason, requestId: req.requestId, now: now(),
    });
    const userId = await ownerUser(out.professionalId);
    if (userId) {
      await notifyUsers(deps, [userId], {
        category: 'application_updates', type: `assignment.${out.status}`, title: `Assignment ${statusText(out.status)}: ${out.jobTitle}`,
        body: `Status: ${statusText(out.status)}.${out.status === 'cancelled_by_facility' && b.reason ? ` Message from the facility: ${b.reason}` : ''}`,
        data: { assignmentId: out.id, shiftId: out.shiftId },
      });
    }
    res.json({ assignment: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  return r;
}

/** Professional side, mounted at /professionals/me. Scoped by the caller's own professional id. */
export function shiftOfferProfessionalRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router();
  const me = (req: Request) => loadProfessional(db, req.auth!.userId);

  /**
   * Adds what a professional needs to say yes with confidence: the job's requirements and whether they meet them right now.
   * The eligibility shown is the same check the platform will run again when they accept.
   */
  async function withDecisionDetails(rows: { id: string; job_id: string; shift_id: string; application_id: string; status: string }[], professionalId: string) {
    const jobIds = [...new Set(rows.map((r) => r.job_id))];
    const reqs = jobIds.length ? await db.query<{ job_id: string; kind: string; credential_type: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }>(
      'SELECT job_id, kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = ANY($1::uuid[]) ORDER BY mandatory DESC, created_at, id', [jobIds]) : [];
    const out = [];
    for (const r of rows) {
      let eligibility: { outcome: string; reasons: { code: string; message: string }[] } | null = null;
      if (r.status === 'sent') {
        const m = await evaluateMatch(db, { professionalId, jobId: r.job_id, shiftIds: [r.shift_id], now: now(), excludeApplicationId: r.application_id });
        eligibility = { outcome: m.eligibility.outcome, reasons: m.eligibility.reasons.map((x) => ({ code: x.code, message: x.message })) };
      }
      out.push({ ...r, requirements: reqs.filter((q) => q.job_id === r.job_id).map(({ job_id: _j, ...rest }) => rest), eligibility });
    }
    return out;
  }

  r.get('/shift-offers', async (req, res) => {
    const p = await me(req);
    await expireOffers(db, now());
    const q = offerListQuery.parse(req.query);
    const args: unknown[] = [p.id];
    let where = 'o.professional_id = $1';
    if (q.status) { args.push(q.status); where += ` AND o.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM shift_offers o WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${OFFER_COLS}, s.notes AS shift_notes, l.name AS location_name, l.address_line1, org.name AS organization_name,
              asg.id AS assignment_id, asg.status AS assignment_status, asg.created_at AS assignment_created_at, asg.undone_at AS assignment_undone_at
         FROM ${OFFER_FROM} JOIN organizations org ON org.id = o.organization_id LEFT JOIN assignments asg ON asg.offer_id = o.id
        WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ offers: await withDecisionDetails(rows as any[], p.id), undoWindowMinutes: UNDO_WINDOW_MINUTES, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/shift-offers/:id', validate({ params: idParams }), async (req, res) => {
    const p = await me(req);
    await expireOffers(db, now());
    const [offer] = await db.query<any>(
      `SELECT ${OFFER_COLS}, s.positions, s.notes AS shift_notes, l.name AS location_name, l.address_line1, org.name AS organization_name FROM ${OFFER_FROM} JOIN organizations org ON org.id = o.organization_id
        WHERE o.id = $1 AND o.professional_id = $2`, [param(req, 'id'), p.id]);
    if (!offer) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [asg] = await db.query<{ id: string }>('SELECT id FROM assignments WHERE offer_id = $1', [offer.id]);
    res.json({ offer: (await withDecisionDetails([offer], p.id))[0], assignmentId: asg?.id ?? null });
  });

  r.post('/shift-offers/:id/respond', validate({ params: idParams, body: respondBody }), async (req, res) => {
    const p = await me(req);
    if (p.account_status !== 'active') throw new AppError('FORBIDDEN', 'Your professional account is restricted.');
    const b = req.body as z.infer<typeof respondBody>;
    const out = await respondToShiftOffer(db, {
      offerId: param(req, 'id'), professionalId: p.id, actorUserId: req.auth!.userId, response: b.response, requestId: req.requestId, now: now(),
    });
    const [who] = await db.query<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [req.auth!.userId]);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.organizationId, 'applications.manage'), {
      category: 'application_updates', type: `shift_offer.${out.status}`, title: `Shift offer ${out.status}: ${out.jobTitle}`,
      body: `${who?.full_name ?? 'The professional'} ${out.status} the shift offer.`, data: { offerId: out.offerId, shiftId: out.shiftId, assignmentId: out.assignmentId },
    });
    const accepted = out.status === 'accepted';
    res.json({
      offer: { id: out.offerId, status: out.status }, assignmentId: out.assignmentId,
      ...(accepted ? {
        undoUntil: new Date(now().getTime() + UNDO_WINDOW_MINUTES * 60_000).toISOString(),
        nextSteps: [
          'Your shift is booked and the facility has been told.',
          `You can undo this in the next ${UNDO_WINDOW_MINUTES} minutes with no questions asked. After that, cancelling needs a reason.`,
          'After the shift, record your hours under Timesheets. The facility approves them, and you can then review the shift.',
        ],
      } : {}),
    });
  });

  /** Takes back an acceptance made within the undo window. It does not count against reliability. */
  r.post('/assignments/:id/undo', validate({ params: idParams, body: undoBody }), async (req, res) => {
    const p = await me(req);
    const out = await transitionAssignment(db, {
      assignmentId: param(req, 'id'), actorKind: 'professional', actorUserId: req.auth!.userId, professionalId: p.id,
      to: 'cancelled_by_professional', reason: (req.body as z.infer<typeof undoBody>)?.reason, requestId: req.requestId, now: now(), undo: true,
    });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.organizationId, 'applications.manage'), {
      category: 'application_updates', type: 'assignment.undone', title: `Shift reopened: ${out.jobTitle}`,
      body: 'The professional took back their acceptance moments after making it. The shift is open again.', data: { assignmentId: out.id, shiftId: out.shiftId },
    });
    res.json({ assignment: { id: out.id, status: out.status } });
  });

  r.get('/assignments', async (req, res) => {
    const p = await me(req);
    const q = assignmentListQuery.parse(req.query);
    const args: unknown[] = [p.id];
    let where = 'a.professional_id = $1';
    if (q.status) { args.push(q.status); where += ` AND a.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM assignments a WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${ASSIGNMENT_COLS}, org.name AS organization_name FROM ${ASSIGNMENT_FROM} JOIN organizations org ON org.id = a.organization_id
        WHERE ${where} ORDER BY s.starts_at DESC, a.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ assignments: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/assignments/:id', validate({ params: idParams }), async (req, res) => {
    const p = await me(req);
    const [a] = await db.query<any>(
      `SELECT ${ASSIGNMENT_COLS}, org.name AS organization_name FROM ${ASSIGNMENT_FROM} JOIN organizations org ON org.id = a.organization_id
        WHERE a.id = $1 AND a.professional_id = $2`, [param(req, 'id'), p.id]);
    if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
    const history = await db.query('SELECT actor_kind, from_status, to_status, reason, created_at FROM assignment_status_history WHERE assignment_id = $1 ORDER BY seq', [a.id]);
    res.json({ assignment: a, history });
  });

  r.post('/assignments/:id/cancel', validate({ params: idParams, body: professionalCancelBody }), async (req, res) => {
    const p = await me(req);
    const b = req.body as z.infer<typeof professionalCancelBody>;
    const out = await transitionAssignment(db, {
      assignmentId: param(req, 'id'), actorKind: 'professional', actorUserId: req.auth!.userId, professionalId: p.id,
      to: 'cancelled_by_professional', reason: b.reason, requestId: req.requestId, now: now(),
    });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.organizationId, 'applications.manage'), {
      category: 'application_updates', type: 'assignment.cancelled_by_professional', title: `Assignment cancelled: ${out.jobTitle}`,
      body: `The professional cancelled. Reason: ${b.reason}`, data: { assignmentId: out.id, shiftId: out.shiftId },
    });
    res.json({ assignment: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  return r;
}
