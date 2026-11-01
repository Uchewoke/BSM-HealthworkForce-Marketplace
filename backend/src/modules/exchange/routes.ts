import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission, requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { audit } from '../audit/service.js';
import { isSignedOff, requireSignedOff } from '../legal/service.js';
import { evaluateMatch } from '../matching/loader.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { loadProfessional } from '../professionals/service.js';
import { stateCode } from '../professionals/schemas.js';
import { talentRefFor } from '../talent/refs.js';
import { acceptFloatRequest, createFloatRequest, expireFloatRequests, loadCardParts, MIN_COUNT_SHOWN } from './service.js';
import { EXCHANGE_TERMS_TEXT, EXCHANGE_TERMS_VERSION, POOL_CONSENT_TEXT, POOL_CONSENT_VERSION } from './terms.js';

const MAX_POOL_WINDOW = 300;
const OUTCOME_ORDER = ['eligible', 'pending_verification', 'needs_review', 'unavailable', 'expired_credential', 'ineligible'];
const idParams = z.object({ id: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });
const orgIdParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const regionParams = z.object({ orgId: z.uuid(), regionId: z.uuid() });
const paging = { page: z.coerce.number().int().min(1).max(100).default(1), pageSize: z.coerce.number().int().min(1).max(25).default(12) };

// ---------------------------------------------------------------- staff
const regionBody = z.object({ name: z.string().trim().min(3).max(100), states: z.array(stateCode).min(1).max(60).transform((s) => [...new Set(s)]) });
const regionPatch = z.object({ name: z.string().trim().min(3).max(100).optional(), states: regionBody.shape.states.optional(), active: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');
const participantStatusBody = z.object({ status: z.enum(['suspended', 'active']), reason: z.string().trim().min(3).max(1000) });

/** Region setup and oversight for staff, mounted at /admin/exchange. */
export function adminExchangeRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const manage = requirePlatformPermission('admin.marketplace_oversight');

  r.get('/regions', manage, async (_req, res) => {
    const rows = await db.query(
      `SELECT r.id, r.name, r.states, r.active, r.created_at,
              (SELECT count(*) FROM float_pool_members m WHERE m.region_id = r.id AND m.status = 'active') AS pool_members,
              (SELECT count(*) FROM exchange_participants p WHERE p.region_id = r.id AND p.status = 'active') AS participating_facilities
         FROM exchange_regions r ORDER BY r.name`);
    res.json({ regions: rows.map((x: any) => ({ ...x, pool_members: Number(x.pool_members), participating_facilities: Number(x.participating_facilities) })) });
  });

  r.post('/regions', validate({ body: regionBody }), manage, async (req, res) => {
    const [row] = await db.query<{ id: string }>('INSERT INTO exchange_regions (name, states, created_by) VALUES ($1,$2,$3) RETURNING id', [req.body.name, req.body.states, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'exchange.region_created', targetType: 'exchange_region', targetId: row!.id, requestId: req.requestId, metadata: { states: req.body.states } });
    res.status(201).json({ region: { id: row!.id, ...req.body, active: true } });
  });

  r.patch('/regions/:id', validate({ params: idParams, body: regionPatch }), manage, async (req, res) => {
    const b = req.body as z.infer<typeof regionPatch>;
    const rows = await db.query(
      `UPDATE exchange_regions SET name = COALESCE($2, name), states = COALESCE($3, states), active = COALESCE($4, active), updated_at = now() WHERE id = $1 RETURNING id, name, states, active`,
      [param(req, 'id'), b.name ?? null, b.states ?? null, b.active ?? null]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'exchange.region_updated', targetType: 'exchange_region', targetId: param(req, 'id'), requestId: req.requestId, metadata: { fields: Object.keys(b) } });
    res.json({ region: rows[0] });
  });

  r.get('/participants', manage, async (_req, res) => {
    const rows = await db.query(
      `SELECT p.id, p.status, p.status_reason, p.accepted_at, o.id AS organization_id, o.name AS organization_name, r.name AS region_name
         FROM exchange_participants p JOIN organizations o ON o.id = p.organization_id JOIN exchange_regions r ON r.id = p.region_id ORDER BY r.name, o.name LIMIT 500`);
    res.json({ participants: rows });
  });

  r.post('/participants/:id/status', validate({ params: idParams, body: participantStatusBody }), manage, async (req, res) => {
    const rows = await db.query<{ organization_id: string; region_id: string }>(
      `UPDATE exchange_participants SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 AND status <> 'withdrawn' RETURNING organization_id, region_id`,
      [param(req, 'id'), req.body.status, req.body.reason]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (req.body.status === 'suspended') {
      await db.query(`UPDATE float_requests SET status = 'withdrawn', failure_reason = 'Participation suspended', responded_at = now() WHERE organization_id = $1 AND region_id = $2 AND status = 'pending'`, [rows[0].organization_id, rows[0].region_id]);
    }
    await audit(db, { actorUserId: req.auth!.userId, action: `exchange.participation_${req.body.status}`, targetType: 'exchange_participant', targetId: param(req, 'id'), organizationId: rows[0].organization_id, requestId: req.requestId, metadata: { reason: req.body.reason } });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, rows[0].organization_id, 'org.update'), {
      category: 'review_decisions', type: `exchange.participation_${req.body.status}`, title: `Your regional exchange participation was ${req.body.status}`, body: req.body.reason,
    });
    res.json({ participant: { id: param(req, 'id'), status: req.body.status } });
  });
  return r;
}

// ---------------------------------------------------------------- professionals
const joinBody = z.object({ regionId: z.uuid(), accept: z.literal(true, { error: 'You must agree to the pool terms to join.' }) });
const leaveBody = z.object({ regionId: z.uuid() });
const respondBody = z.object({ response: z.enum(['accepted', 'declined']) });

/** The professional's side, mounted at /professionals/me/float-pool. */
export function professionalExchangeRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router();

  r.get('/', async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const regions = await db.query<{ id: string; name: string; states: string[]; joined: boolean }>(
      `SELECT r.id, r.name, r.states, EXISTS (SELECT 1 FROM float_pool_members m WHERE m.region_id = r.id AND m.professional_id = $1 AND m.status = 'active') AS joined
         FROM exchange_regions r WHERE r.active ORDER BY r.name`, [p.id]);
    res.json({ available: await isSignedOff(db, 'float_pool'), regions, terms: { version: POOL_CONSENT_VERSION, text: POOL_CONSENT_TEXT } });
  });

  r.post('/join', validate({ body: joinBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    await requireSignedOff(db, 'float_pool');
    if (p.account_status !== 'active') throw new AppError('FORBIDDEN', 'Your professional account is restricted.');
    const [region] = await db.query('SELECT 1 FROM exchange_regions WHERE id = $1 AND active', [req.body.regionId]);
    if (!region) throw new AppError('NOT_FOUND', 'Resource not found.');
    await db.query(
      `INSERT INTO float_pool_members (region_id, professional_id, consent_version) VALUES ($1,$2,$3)
       ON CONFLICT (region_id, professional_id) DO UPDATE SET status = 'active', consent_version = EXCLUDED.consent_version, consented_at = now(), left_at = NULL`,
      [req.body.regionId, p.id, POOL_CONSENT_VERSION]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'float_pool.joined', targetType: 'exchange_region', targetId: req.body.regionId, requestId: req.requestId, metadata: { consentVersion: POOL_CONSENT_VERSION } });
    res.status(201).json({ joined: true, consentVersion: POOL_CONSENT_VERSION });
  });

  r.post('/leave', validate({ body: leaveBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const rows = await db.query(`UPDATE float_pool_members SET status = 'left', left_at = now() WHERE region_id = $1 AND professional_id = $2 AND status = 'active' RETURNING id`, [req.body.regionId, p.id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    // Leaving withdraws anything still waiting for an answer from this region.
    await db.query(`UPDATE float_requests SET status = 'withdrawn', failure_reason = 'The professional left the pool', responded_at = now() WHERE professional_id = $1 AND region_id = $2 AND status = 'pending'`, [p.id, req.body.regionId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'float_pool.left', targetType: 'exchange_region', targetId: req.body.regionId, requestId: req.requestId });
    res.status(204).end();
  });

  r.get('/requests', async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    await expireFloatRequests(db, now());
    const rows = await db.query(
      `SELECT f.id, f.status, f.hourly_rate_cents, f.message, f.created_at, f.expires_at, f.failure_reason, j.title, o.name AS organization_name, l.city, l.state, s.starts_at, s.ends_at
         FROM float_requests f JOIN shifts s ON s.id = f.shift_id JOIN jobs j ON j.id = s.job_id JOIN organizations o ON o.id = f.organization_id JOIN facility_locations l ON l.id = j.location_id
        WHERE f.professional_id = $1 ORDER BY (f.status = 'pending') DESC, f.created_at DESC LIMIT 100`, [p.id]);
    res.json({ requests: rows });
  });

  r.post('/requests/:id/respond', validate({ params: idParams, body: respondBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    if (req.body.response === 'declined') {
      await expireFloatRequests(db, now());
      const rows = await db.query<{ organization_id: string }>(`UPDATE float_requests SET status = 'declined', responded_at = now() WHERE id = $1 AND professional_id = $2 AND status = 'pending' RETURNING organization_id`, [param(req, 'id'), p.id]);
      if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
      await audit(db, { actorUserId: req.auth!.userId, action: 'float_request.declined', targetType: 'float_request', targetId: param(req, 'id'), organizationId: rows[0].organization_id, requestId: req.requestId });
      // The facility learns only that a pool member declined, never who.
      await notifyUsers(deps, await orgUserIdsWithPermission(db, rows[0].organization_id, 'applications.manage'), {
        category: 'application_updates', type: 'float_request.declined', title: 'A pool member declined your shift request', data: { floatRequestId: param(req, 'id') },
      });
      res.json({ request: { id: param(req, 'id'), status: 'declined' } });
      return;
    }
    const out = await acceptFloatRequest(db, { requestId: param(req, 'id'), professionalId: p.id, userId: req.auth!.userId, httpRequestId: req.requestId, now: now() });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.organizationId, 'applications.manage'), {
      category: 'application_updates', type: 'float_request.accepted', title: `A pool member accepted your shift request: ${out.jobTitle}`, data: { assignmentId: out.assignmentId, shiftId: out.shiftId },
    });
    res.json({ request: { id: param(req, 'id'), status: 'accepted' }, assignmentId: out.assignmentId });
  });
  return r;
}

// ---------------------------------------------------------------- facilities
const participationBody = z.object({ regionId: z.uuid(), acceptTerms: z.literal(true, { error: 'You must accept the exchange terms.' }) });
const poolQuery = z.object({
  regionId: z.uuid(),
  shiftId: z.uuid().optional(),
  professionId: z.uuid().optional(),
  show: z.enum(['eligible', 'all']).optional(),
  ...paging,
});
const requestBody = z.object({ talentRef: z.string().min(10).max(64), shiftId: z.uuid(), hourlyRateCents: z.number().int().min(0).max(100_000).optional(), message: z.string().trim().min(1).max(500).optional() });
const requestListQuery = z.object({ status: z.enum(['pending', 'accepted', 'declined', 'withdrawn', 'expired', 'failed']).optional(), ...paging });

/** The facility's side, mounted at /organizations/:orgId/exchange. */
export function facilityExchangeRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const searchLimiter = new RateLimiter(60, 60_000, deps.now ?? Date.now);
  const r = Router({ mergeParams: true });
  const orgOf = (req: Request) => req.membership!.organizationId;
  const search = [requireOrgPermission(deps, 'professionals.search'), requireApprovedOrg(deps)];

  async function requireParticipation(orgId: string, regionId: string) {
    await requireSignedOff(db, 'float_pool');
    const [p] = await db.query('SELECT 1 FROM exchange_participants ep JOIN exchange_regions r ON r.id = ep.region_id WHERE ep.organization_id = $1 AND ep.region_id = $2 AND ep.status = $3 AND r.active', [orgId, regionId, 'active']);
    if (!p) throw new AppError('FORBIDDEN', 'Your organization does not participate in this region’s exchange.');
  }

  // ---- participation
  r.get('/regions', validate({ params: orgParams }), requireOrgPermission(deps, 'org.read'), async (req, res) => {
    const rows = await db.query<any>(
      `SELECT r.id, r.name, r.states, ep.status AS participation,
              EXISTS (SELECT 1 FROM facility_locations l WHERE l.organization_id = $1 AND l.active AND l.state = ANY(r.states)) AS has_location
         FROM exchange_regions r LEFT JOIN exchange_participants ep ON ep.region_id = r.id AND ep.organization_id = $1 WHERE r.active ORDER BY r.name`, [orgOf(req)]);
    res.json({ available: await isSignedOff(db, 'float_pool'), regions: rows, terms: { version: EXCHANGE_TERMS_VERSION, text: EXCHANGE_TERMS_TEXT } });
  });

  r.post('/participation', validate({ params: orgParams, body: participationBody }), requireOrgPermission(deps, 'org.update'), requireApprovedOrg(deps), async (req, res) => {
    const orgId = orgOf(req);
    await requireSignedOff(db, 'float_pool');
    const [region] = await db.query<{ states: string[] }>('SELECT states FROM exchange_regions WHERE id = $1 AND active', [req.body.regionId]);
    if (!region) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [loc] = await db.query('SELECT 1 FROM facility_locations WHERE organization_id = $1 AND active AND state = ANY($2::text[])', [orgId, region.states]);
    if (!loc) throw new AppError('VALIDATION_FAILED', 'Your organization has no active location in this region.');
    const [existing] = await db.query<{ status: string }>('SELECT status FROM exchange_participants WHERE organization_id = $1 AND region_id = $2', [orgId, req.body.regionId]);
    if (existing?.status === 'suspended') throw new AppError('FORBIDDEN', 'Your participation in this region was suspended by BSM.');
    await db.query(
      `INSERT INTO exchange_participants (organization_id, region_id, terms_version, accepted_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, region_id) DO UPDATE SET status = 'active', terms_version = EXCLUDED.terms_version, accepted_by = EXCLUDED.accepted_by, accepted_at = now(), status_reason = NULL, updated_at = now()`,
      [orgId, req.body.regionId, EXCHANGE_TERMS_VERSION, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'exchange.joined', targetType: 'exchange_region', targetId: req.body.regionId, organizationId: orgId, requestId: req.requestId, metadata: { termsVersion: EXCHANGE_TERMS_VERSION } });
    res.status(201).json({ participating: true });
  });

  r.delete('/participation/:regionId', validate({ params: regionParams }), requireOrgPermission(deps, 'org.update'), async (req, res) => {
    const rows = await db.query(`UPDATE exchange_participants SET status = 'withdrawn', updated_at = now() WHERE organization_id = $1 AND region_id = $2 AND status = 'active' RETURNING id`, [orgOf(req), param(req, 'regionId')]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await db.query(`UPDATE float_requests SET status = 'withdrawn', failure_reason = 'The facility left the exchange', responded_at = now() WHERE organization_id = $1 AND region_id = $2 AND status = 'pending'`, [orgOf(req), param(req, 'regionId')]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'exchange.left', targetType: 'exchange_region', targetId: param(req, 'regionId'), organizationId: orgOf(req), requestId: req.requestId });
    res.status(204).end();
  });

  /** The organization's own open, upcoming shifts that fall inside a region, so a request can be matched to one. */
  r.get('/shifts', validate({ params: orgParams }), ...search, async (req, res) => {
    const regionId = z.uuid().parse(req.query.regionId);
    await requireParticipation(orgOf(req), regionId);
    const rows = await db.query(
      `SELECT s.id, s.starts_at, s.ends_at, s.positions, s.hourly_rate_cents, j.title, l.city, l.state,
              s.positions - (SELECT count(*) FROM assignments a WHERE a.shift_id = s.id AND a.status IN ('confirmed','completed')) AS open_positions
         FROM shifts s JOIN jobs j ON j.id = s.job_id JOIN facility_locations l ON l.id = j.location_id JOIN exchange_regions r ON r.id = $2
        WHERE s.organization_id = $1 AND s.status = 'open' AND s.starts_at > now() AND j.status IN ('published','paused') AND l.state = ANY(r.states)
        ORDER BY s.starts_at LIMIT 100`, [orgOf(req), regionId]);
    res.json({ shifts: rows.map((x: any) => ({ ...x, open_positions: Number(x.open_positions) })).filter((x: any) => x.open_positions > 0) });
  });

  // ---- the pool: counts and anonymous cards
  /** How many pool members there are by profession. Small counts are hidden so a handful of people cannot be inferred. */
  r.get('/pool/summary', validate({ params: orgParams }), ...search, async (req, res) => {
    const regionId = z.uuid().parse(req.query.regionId);
    await requireParticipation(orgOf(req), regionId);
    const rows = await db.query<{ name: string; n: string }>(
      `SELECT pr.name, count(*) AS n FROM float_pool_members m JOIN professionals p ON p.id = m.professional_id JOIN users u ON u.id = p.user_id JOIN professions pr ON pr.id = p.profession_id
        WHERE m.region_id = $1 AND m.status = 'active' AND p.account_status = 'active' AND u.status = 'active' GROUP BY pr.name ORDER BY count(*) DESC, pr.name`, [regionId]);
    res.json({ professions: rows.map((x) => ({ profession: x.name, members: Number(x.n) >= MIN_COUNT_SHOWN ? Number(x.n) : null, label: Number(x.n) >= MIN_COUNT_SHOWN ? String(x.n) : `fewer than ${MIN_COUNT_SHOWN}` })) });
  });

  r.get('/pool', validate({ params: orgParams }), ...search, async (req, res) => {
    if (!searchLimiter.allow(`pool:${req.auth!.userId}`)) throw new AppError('RATE_LIMITED', 'Too many searches. Try again shortly.');
    const q = poolQuery.parse(req.query);
    const orgId = orgOf(req);
    await requireParticipation(orgId, q.regionId);
    if ((q.page - 1) * q.pageSize >= MAX_POOL_WINDOW) throw new AppError('VALIDATION_FAILED', 'Refine your search to see more results.');
    const [region] = await db.query<{ states: string[] }>('SELECT states FROM exchange_regions WHERE id = $1', [q.regionId]);

    let shift: { job_id: string; state: string } | undefined;
    if (q.shiftId) {
      [shift] = await db.query<{ job_id: string; state: string }>(
        `SELECT s.job_id, l.state FROM shifts s JOIN jobs j ON j.id = s.job_id JOIN facility_locations l ON l.id = j.location_id
          WHERE s.id = $1 AND s.organization_id = $2 AND s.status = 'open' AND s.starts_at > now() AND j.status IN ('published','paused')`, [q.shiftId, orgId]);
      if (!shift) throw new AppError('NOT_FOUND', 'Resource not found.');
      if (!region!.states.includes(shift.state)) throw new AppError('VALIDATION_FAILED', 'That shift is not in this region.');
    }

    const args: unknown[] = [q.regionId];
    let where = `m.region_id = $1 AND m.status = 'active' AND p.account_status = 'active' AND u.status = 'active'`;
    if (q.professionId) { args.push(q.professionId); where += ` AND p.profession_id = $${args.length}`; }
    const rows = await db.query<{ id: string; city: string | null; state: string | null; profession: string }>(
      `SELECT p.id, p.city, p.state, pr.name AS profession FROM float_pool_members m JOIN professionals p ON p.id = m.professional_id JOIN users u ON u.id = p.user_id JOIN professions pr ON pr.id = p.profession_id
        WHERE ${where} ORDER BY m.consented_at DESC, p.id LIMIT ${MAX_POOL_WINDOW}`, args);
    const parts = await loadCardParts(db, rows.map((x) => x.id), now());
    let cards = rows.map((p) => ({
      id: p.id, profession: p.profession, specialties: parts.specialties.get(p.id) ?? [], city: p.city, state: p.state, yearsExperience: parts.years.get(p.id) ?? 0,
      credentials: parts.credentials.get(p.id) ?? [], availability: parts.windows.get(p.id) ?? [],
      match: null as null | { outcome: string; score: number | null; reasons: { code: string; message: string }[] },
    }));
    if (shift) {
      for (const c of cards) {
        const m = await evaluateMatch(db, { professionalId: c.id, jobId: shift.job_id, shiftIds: [q.shiftId!], now: now() });
        c.match = { outcome: m.eligibility.outcome, score: m.rank?.score ?? null, reasons: m.eligibility.reasons.map((x) => ({ code: x.code, message: x.message })) };
      }
      if ((q.show ?? 'eligible') === 'eligible') cards = cards.filter((c) => c.match!.outcome === 'eligible');
      cards.sort((a, b) => OUTCOME_ORDER.indexOf(a.match!.outcome) - OUTCOME_ORDER.indexOf(b.match!.outcome) || (b.match!.score ?? 0) - (a.match!.score ?? 0));
    }
    const total = cards.length;
    const out = [];
    for (const c of cards.slice((q.page - 1) * q.pageSize, q.page * q.pageSize)) {
      const { id, ...card } = c;
      out.push({ talentRef: await talentRefFor(db, orgId, id), ...card });
    }
    await audit(db, { actorUserId: req.auth!.userId, action: 'exchange.pool_search', organizationId: orgId, requestId: req.requestId, metadata: { regionId: q.regionId, filters: Object.keys(req.query), results: total } });
    res.json({ pool: out, page: q.page, pageSize: q.pageSize, total, note: 'Pool members appear anonymously. Eligibility and ranking (when a shift is chosen) never override mandatory requirements.' });
  });

  // ---- requests
  r.post('/requests', validate({ params: orgParams, body: requestBody }), requireOrgPermission(deps, 'applications.manage'), requireApprovedOrg(deps), async (req, res) => {
    const b = req.body as z.infer<typeof requestBody>;
    const [ref] = await db.query<{ professional_id: string }>('SELECT professional_id FROM talent_refs WHERE organization_id = $1 AND ref = $2', [orgOf(req), b.talentRef]);
    if (!ref) throw new AppError('NOT_FOUND', 'Resource not found.');
    const out = await createFloatRequest(deps, { organizationId: orgOf(req), professionalId: ref.professional_id, shiftId: b.shiftId, hourlyRateCents: b.hourlyRateCents, message: b.message, userId: req.auth!.userId, requestId: req.requestId, now: now() });
    res.status(201).json({ request: { id: out.id, status: 'pending', expiresAt: out.expiresAt } });
  });

  r.get('/requests', validate({ params: orgParams }), requireOrgPermission(deps, 'applications.read'), async (req, res) => {
    const q = requestListQuery.parse(req.query);
    await expireFloatRequests(db, now());
    const args: unknown[] = [orgOf(req)];
    let where = 'f.organization_id = $1';
    if (q.status) { args.push(q.status); where += ` AND f.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM float_requests f WHERE ${where}`, args);
    // Identity appears only through application_id, which exists once the professional accepted.
    const rows = await db.query(
      `SELECT f.id, f.status, f.hourly_rate_cents, f.created_at, f.expires_at, f.failure_reason, f.application_id, j.title, s.starts_at, s.ends_at, pr.name AS profession
         FROM float_requests f JOIN shifts s ON s.id = f.shift_id JOIN jobs j ON j.id = s.job_id JOIN professionals p ON p.id = f.professional_id JOIN professions pr ON pr.id = p.profession_id
        WHERE ${where} ORDER BY f.created_at DESC, f.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ requests: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.delete('/requests/:id', validate({ params: orgIdParams }), requireOrgPermission(deps, 'applications.manage'), async (req, res) => {
    const rows = await db.query(`UPDATE float_requests SET status = 'withdrawn', responded_at = now() WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`, [param(req, 'id'), orgOf(req)]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'float_request.withdrawn', targetType: 'float_request', targetId: param(req, 'id'), organizationId: orgOf(req), requestId: req.requestId });
    res.status(204).end();
  });
  return r;
}
