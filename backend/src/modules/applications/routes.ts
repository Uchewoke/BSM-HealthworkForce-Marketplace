import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { audit } from '../audit/service.js';
import { statusLabel } from '../credentials/labels.js';
import { FROM_WHERE_BASE } from '../jobs/search.js';
import { evaluateMatch, evaluateMatches, snapshotMatch, type MatchResult } from '../matching/loader.js';
import { facilityView } from '../matching/ranking.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { loadProfessional } from '../professionals/service.js';
import { professionalRating, reliability } from '../reviews/service.js';
import { APPLICATION_STATUSES, statusText, transitionApplication } from './service.js';

const applyBody = z.object({
  coverNote: z.string().trim().min(1).max(2000).optional(),
  shiftIds: z.array(z.uuid()).max(20).optional(),
});
const facilityStatusBody = z.object({
  to: z.enum(['under_review', 'shortlisted', 'interview_requested', 'interviewed', 'offer_sent', 'rejected', 'cancelled']),
  reason: z.string().trim().min(3).max(2000).optional(),
});
const professionalStatusBody = z.object({ to: z.enum(['withdrawn', 'accepted', 'declined']), reason: z.string().trim().min(3).max(2000).optional() });
const listQuery = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  jobId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const candidatesQuery = z.object({
  includeClosed: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const idParams = z.object({ id: z.uuid() });
const orgJobParams = z.object({ orgId: z.uuid(), jobId: z.uuid() });
const orgAppParams = z.object({ orgId: z.uuid(), appId: z.uuid() });
const CLOSED = ['withdrawn', 'cancelled', 'declined', 'rejected'];
const MAX_CANDIDATES = 500;
const OUTCOME_ORDER = ['eligible', 'pending_verification', 'needs_review', 'unavailable', 'expired_credential', 'ineligible'];

const publicEligibility = (m: MatchResult) => ({ outcome: m.eligibility.outcome, reasons: m.eligibility.reasons });

/** POST /jobs/:id/apply — a professional applies directly to a listable job. */
export function applyRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(30, 3600_000, now, deps.limits);
  const r = Router();
  r.post('/:id/apply', needAuth, validate({ params: idParams, body: applyBody }), async (req, res) => {
    if (!(await limiter.allow(`apply:${req.auth!.userId}`))) throw new AppError('RATE_LIMITED', 'Too many applications. Try again later.');
    const prof = await loadProfessional(db, req.auth!.userId);
    if (prof.account_status !== 'active') throw new AppError('FORBIDDEN', 'Your professional account is restricted.');
    const jobId = param(req, 'id');
    const [job] = await db.query<{ id: string; organization_id: string; employment_type: string; title: string }>(
      `SELECT j.id, j.organization_id, j.employment_type, j.title ${FROM_WHERE_BASE} AND j.id = $1`, [jobId]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.'); // not published / not listable
    const [member] = await db.query(`SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, [job.organization_id, req.auth!.userId]);
    if (member) throw new AppError('CONFLICT', 'You cannot apply to a job posted by your own organization.');

    const { coverNote, shiftIds = [] } = req.body as z.infer<typeof applyBody>;
    const uniqueShiftIds = [...new Set(shiftIds)];
    if (uniqueShiftIds.length) {
      if (job.employment_type === 'permanent') throw new AppError('VALIDATION_FAILED', 'Permanent positions do not have shifts.', { fieldErrors: { shiftIds: ['Not applicable'] } });
      const ok = await db.query(`SELECT id FROM shifts WHERE id = ANY($1::uuid[]) AND job_id = $2 AND status = 'open' AND starts_at > now()`, [uniqueShiftIds, jobId]);
      if (ok.length !== uniqueShiftIds.length) throw new AppError('VALIDATION_FAILED', 'Choose open, upcoming shifts of this job.', { fieldErrors: { shiftIds: ['Invalid shift'] } });
    }

    // Mandatory requirements must at least be on the way: hard failures are refused up front with the reasons.
    const match = await evaluateMatch(db, { professionalId: prof.id, jobId, shiftIds: uniqueShiftIds, now: new Date(now()) });
    if (['ineligible', 'expired_credential', 'unavailable'].includes(match.eligibility.outcome)) {
      throw new AppError('CONFLICT', 'You do not currently meet the mandatory requirements for this opportunity.', publicEligibility(match));
    }

    const app = await db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        'INSERT INTO applications (job_id, organization_id, professional_id, cover_note) VALUES ($1,$2,$3,$4) RETURNING id',
        [jobId, job.organization_id, prof.id, coverNote ?? null]);
      for (const sid of uniqueShiftIds) await tx.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3)', [row!.id, sid, job.organization_id]);
      await tx.query(`INSERT INTO application_events (application_id, actor_user_id, actor_kind, from_status, to_status) VALUES ($1,$2,'professional',NULL,'submitted')`, [row!.id, req.auth!.userId]);
      await snapshotMatch(tx, { applicationId: row!.id, organizationId: job.organization_id, jobId, professionalId: prof.id, trigger: 'apply', match });
      await tx.query(`UPDATE talent_invitations SET status = 'applied', application_id = $1, responded_at = now() WHERE job_id = $2 AND professional_id = $3 AND status = 'pending'`, [row!.id, jobId, prof.id]);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'application.submitted', targetType: 'application', targetId: row!.id, organizationId: job.organization_id, requestId: req.requestId });
      return row!;
    });

    const [who] = await db.query<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [req.auth!.userId]);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, job.organization_id, 'applications.manage'), {
      category: 'application_updates', type: 'application.submitted', title: `New application: ${job.title}`,
      body: `${who?.full_name ?? 'A professional'} applied. Eligibility: ${match.eligibility.outcome.replace(/_/g, ' ')}.`,
      data: { applicationId: app.id, jobId, organizationId: job.organization_id },
    });
    res.status(201).json({ application: { id: app.id, status: 'submitted' }, eligibility: publicEligibility(match) });
  });
  return r;
}

/** The professional's own applications, mounted at /professionals/me/applications. */
export function professionalApplicationRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  const me = (req: Request) => loadProfessional(db, req.auth!.userId);

  r.get('/', async (req, res) => {
    const p = await me(req);
    const q = listQuery.parse(req.query);
    const args: unknown[] = [p.id];
    let where = 'a.professional_id = $1';
    if (q.status) { args.push(q.status); where += ` AND a.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM applications a WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT a.id, a.status, a.created_at, a.updated_at, j.id AS job_id, j.title, j.employment_type, j.status AS job_status, o.name AS organization_name, l.city, l.state
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN organizations o ON o.id = a.organization_id JOIN facility_locations l ON l.id = j.location_id
        WHERE ${where} ORDER BY a.updated_at DESC, a.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ applications: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/:id', validate({ params: idParams }), async (req, res) => {
    const p = await me(req);
    const [a] = await db.query<any>(
      `SELECT a.id, a.status, a.cover_note, a.created_at, a.job_id, j.title, j.employment_type, o.name AS organization_name
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN organizations o ON o.id = a.organization_id WHERE a.id = $1 AND a.professional_id = $2`, [param(req, 'id'), p.id]);
    if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
    const shiftIds = (await db.query<{ shift_id: string }>('SELECT shift_id FROM application_shifts WHERE application_id = $1', [a.id])).map((s) => s.shift_id);
    const match = await evaluateMatch(db, { professionalId: p.id, jobId: a.job_id, shiftIds, now: new Date(now()), excludeApplicationId: a.id });
    const history = await db.query(
      `SELECT actor_kind, from_status, to_status, reason, created_at FROM application_events WHERE application_id = $1 ORDER BY seq`, [a.id]);
    // The professional sees why they are or are not eligible. The facility-side score and ranking are not shown to them.
    res.json({ application: a, eligibility: { ...publicEligibility(match), requirements: match.eligibility.requirements, shifts: match.eligibility.shifts }, history });
  });

  r.post('/:id/status', validate({ params: idParams, body: professionalStatusBody }), async (req, res) => {
    const p = await me(req);
    const b = req.body as z.infer<typeof professionalStatusBody>;
    const out = await transitionApplication(db, {
      applicationId: param(req, 'id'), actorKind: 'professional', actorUserId: req.auth!.userId, professionalId: p.id,
      to: b.to, reason: b.reason, requestId: req.requestId, now: new Date(now()),
    });
    const [who] = await db.query<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [req.auth!.userId]);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.organizationId, 'applications.manage'), {
      category: 'application_updates', type: `application.${out.status}`, title: `Application ${statusText(out.status)}: ${out.jobTitle}`,
      body: `${who?.full_name ?? 'The applicant'} ${statusText(out.status)} the application.`, data: { applicationId: out.id, jobId: out.jobId },
    });
    res.json({ application: { id: out.id, status: out.status } });
  });
  return r;
}

/** Facility-side application review, mounted at /organizations/:orgId. Scoped by organization_id on every query. */
export function applicationFacilityRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'applications.read');
  const manage = requireOrgPermission(deps, 'applications.manage');
  const orgOf = (req: Request) => req.membership!.organizationId;

  async function shiftIdsByApp(ids: string[]) {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    for (const row of await db.query<{ application_id: string; shift_id: string }>('SELECT application_id, shift_id FROM application_shifts WHERE application_id = ANY($1::uuid[])', [ids])) {
      map.set(row.application_id, [...(map.get(row.application_id) ?? []), row.shift_id]);
    }
    return map;
  }

  /** Applicants for one job: eligible candidates ranked with explanations first; everyone else listed with the reasons. */
  r.get('/jobs/:jobId/candidates', validate({ params: orgJobParams }), read, async (req, res) => {
    const q = candidatesQuery.parse(req.query);
    const jobId = param(req, 'jobId');
    const [job] = await db.query('SELECT 1 FROM jobs WHERE id = $1 AND organization_id = $2', [jobId, orgOf(req)]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    const apps = await db.query<any>(
      `SELECT a.id, a.status, a.created_at, a.professional_id, u.full_name, p.headline, p.city, p.state
         FROM applications a JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id
        WHERE a.job_id = $1 AND a.organization_id = $2 ${q.includeClosed === 'true' ? '' : `AND a.status <> ALL($3::text[])`}
        ORDER BY a.created_at, a.id LIMIT ${MAX_CANDIDATES}`,
      q.includeClosed === 'true' ? [jobId, orgOf(req)] : [jobId, orgOf(req), CLOSED]);
    const shifts = await shiftIdsByApp(apps.map((a) => a.id));
    const matches = await evaluateMatches(db, {
      jobId, now: new Date(now()),
      candidates: apps.map((a) => ({ professionalId: a.professional_id, shiftIds: shifts.get(a.id) ?? [], excludeApplicationId: a.id })),
    });
    const evaluated = apps.map((a) => ({ a, m: matches.get(a.professional_id)! }));
    await audit(db, { actorUserId: req.auth!.userId, action: 'application.candidates_reviewed', targetType: 'job', targetId: jobId, organizationId: orgOf(req), requestId: req.requestId, metadata: { candidates: apps.length } });
    evaluated.sort((x, y) => {
      const ox = OUTCOME_ORDER.indexOf(x.m.eligibility.outcome), oy = OUTCOME_ORDER.indexOf(y.m.eligibility.outcome);
      if (ox !== oy) return ox - oy;
      if (x.m.rank && y.m.rank && x.m.rank.score !== y.m.rank.score) return y.m.rank.score - x.m.rank.score;
      return new Date(x.a.created_at).getTime() - new Date(y.a.created_at).getTime();
    });
    let rank = 0;
    const items = evaluated.map(({ a, m }) => ({
      applicationId: a.id, status: a.status, appliedAt: a.created_at,
      rank: m.rank ? ++rank : null, score: m.rank?.score ?? null,
      eligibility: publicEligibility(m),
      applicant: { name: a.full_name, headline: a.headline, city: a.city, state: a.state },
    }));
    const start = (q.page - 1) * q.pageSize;
    res.json({
      candidates: items.slice(start, start + q.pageSize), page: q.page, pageSize: q.pageSize, total: items.length,
      truncated: apps.length === MAX_CANDIDATES,
      note: 'Only candidates with outcome "eligible" are ranked. Ranking never overrides a mandatory requirement.',
    });
  });

  r.get('/applications', validate({ params: z.object({ orgId: z.uuid() }) }), read, async (req, res) => {
    const q = listQuery.parse(req.query);
    const args: unknown[] = [orgOf(req)];
    let where = 'a.organization_id = $1';
    if (q.status) { args.push(q.status); where += ` AND a.status = $${args.length}`; }
    if (q.jobId) { args.push(q.jobId); where += ` AND a.job_id = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM applications a WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT a.id, a.status, a.created_at, a.updated_at, a.job_id, j.title, u.full_name AS applicant_name
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id
        WHERE ${where} ORDER BY a.updated_at DESC, a.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ applications: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  /** Application detail. Facilities see profile facts and credential STATUS only: never credential numbers or documents. */
  r.get('/applications/:appId', validate({ params: orgAppParams }), read, async (req, res) => {
    const [a] = await db.query<any>(
      `SELECT a.id, a.status, a.cover_note, a.created_at, a.job_id, a.professional_id, j.title AS job_title,
              u.full_name, p.headline, p.summary, p.city, p.state, pr.name AS profession, ag.name AS submitted_by_agency, a.source
         FROM applications a LEFT JOIN organizations ag ON ag.id = a.submitted_by_agency_id JOIN jobs j ON j.id = a.job_id JOIN professionals p ON p.id = a.professional_id
         JOIN users u ON u.id = p.user_id JOIN professions pr ON pr.id = p.profession_id
        WHERE a.id = $1 AND a.organization_id = $2`, [param(req, 'appId'), orgOf(req)]);
    if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
    const shiftIds = (await shiftIdsByApp([a.id])).get(a.id) ?? [];
    const match = await evaluateMatch(db, { professionalId: a.professional_id, jobId: a.job_id, shiftIds, now: new Date(now()), excludeApplicationId: a.id });
    const specialties = await db.query('SELECT s.name FROM professional_specialties ps JOIN specialties s ON s.id = ps.specialty_id WHERE ps.professional_id = $1 ORDER BY s.name', [a.professional_id]);
    const experience = await db.query('SELECT employer, title, city, state, start_date, end_date, is_current FROM professional_experience WHERE professional_id = $1 ORDER BY start_date DESC', [a.professional_id]);
    const education = await db.query('SELECT institution, degree, field_of_study, end_year FROM professional_education WHERE professional_id = $1 ORDER BY end_year DESC NULLS FIRST', [a.professional_id]);
    const creds = await db.query<any>(
      `SELECT c.kind, c.credential_type, c.jurisdiction, c.expiration_date,
              CASE WHEN c.status NOT IN ('revoked','rejected') AND c.expiration_date < CURRENT_DATE THEN 'expired' ELSE c.status END AS effective_status, c.verification_method
         FROM credentials c WHERE c.professional_id = $1 ORDER BY c.kind, c.credential_type`, [a.professional_id]);
    const history = await db.query('SELECT actor_kind, from_status, to_status, reason, created_at FROM application_events WHERE application_id = $1 ORDER BY seq', [a.id]);
    const shifts = shiftIds.length ? await db.query('SELECT id, starts_at, ends_at FROM shifts WHERE id = ANY($1::uuid[]) ORDER BY starts_at', [shiftIds]) : [];
    const { professional_id: _omit, ...application } = a;
    res.json({
      application,
      applicant: { specialties: specialties.map((s: any) => s.name), experience, education,
        credentials: creds.map((c) => ({ ...c, status_label: statusLabel(c.effective_status, c.verification_method) })) },
      selectedShifts: shifts,
      eligibility: { outcome: match.eligibility.outcome, reasons: match.eligibility.reasons, requirements: match.eligibility.requirements, shifts: match.eligibility.shifts, rulesVersion: match.eligibility.rulesVersion },
      ranking: facilityView(match.rank), // null unless eligible; never includes the professional's pay expectation
      // Context for a human reader only. Reliability and ratings never change eligibility or ranking.
      track: { reliability: await reliability(db, a.professional_id), rating: await professionalRating(db, a.professional_id) },
      history,
    });
  });

  r.post('/applications/:appId/status', validate({ params: orgAppParams, body: facilityStatusBody }), manage, async (req, res) => {
    const b = req.body as z.infer<typeof facilityStatusBody>;
    const out = await transitionApplication(db, {
      applicationId: param(req, 'appId'), actorKind: 'organization', actorUserId: req.auth!.userId, organizationId: orgOf(req),
      to: b.to, reason: b.reason, requestId: req.requestId, now: new Date(now()),
    });
    const [owner] = await db.query<{ user_id: string }>('SELECT user_id FROM professionals WHERE id = $1', [out.professionalId]);
    if (owner) {
      await notifyUsers(deps, [owner.user_id], {
        category: 'application_updates', type: `application.${out.status}`, title: `Update on your application: ${out.jobTitle}`,
        body: `Status: ${statusText(out.status)}.${b.reason && ['rejected', 'cancelled'].includes(out.status) ? ` Message from the facility: ${b.reason}` : ''}`,
        data: { applicationId: out.id, jobId: out.jobId },
      });
    }
    res.json({ application: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  return r;
}
