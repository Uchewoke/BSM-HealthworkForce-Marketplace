import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { assertWithinCountLimit } from '../billing/entitlements.js';
import { meterUsageMw } from '../billing/usage.js';
import { emailSchema } from '../auth/schemas.js';
import { FROM_WHERE_BASE } from '../jobs/search.js';
import { evaluateMatch, snapshotMatch } from '../matching/loader.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { loadProfessional } from '../professionals/service.js';

const orgParams = z.object({ orgId: z.uuid() });
const orgJobParams = z.object({ orgId: z.uuid(), jobId: z.uuid() });
const orgJobAgencyParams = z.object({ orgId: z.uuid(), jobId: z.uuid(), agencyId: z.uuid() });
const rosterParams = z.object({ orgId: z.uuid(), rosterId: z.uuid() });
const idParams = z.object({ id: z.uuid() });
const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
};
const rosterInviteBody = z.object({ email: emailSchema });
const grantBody = z.object({ agencyId: z.uuid() });
const submitBody = z.object({
  professionalId: z.uuid(),
  coverNote: z.string().trim().min(1).max(2000).optional(),
  shiftIds: z.array(z.uuid()).max(20).optional(),
});
const respondBody = z.object({ response: z.enum(['accept', 'decline']) });
const searchQuery = z.object({ q: z.string().trim().min(2).max(100).optional(), ...paging });
const HARD_FAIL = ['ineligible', 'expired_credential', 'unavailable'];
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Resolves only if the :orgId organization is an agency. Run after requireOrgPermission. */
const requireAgency = (deps: AppDeps): RequestHandler => async (req, _res, next) => {
  const [o] = await deps.db.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1', [req.membership!.organizationId]);
  if (o?.type !== 'agency') return next(new AppError('NOT_FOUND', 'Resource not found.'));
  next();
};

/** Agency-side routes, mounted at /organizations/:orgId/agency. Every query is scoped by the agency's organization id. */
export function agencyRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  const guard = (permission: Parameters<typeof requireOrgPermission>[1]) => [requireOrgPermission(deps, permission), requireAgency(deps)];
  const orgOf = (req: Request) => req.membership!.organizationId;

  // ---- roster
  r.get('/roster', validate({ params: orgParams }), ...guard('agency.roster.read'), async (req, res) => {
    const rows = await db.query(
      `SELECT r.id, r.status, r.created_at, r.responded_at, CASE WHEN r.status = 'active' THEN r.professional_id END AS professional_id, u.full_name, pr.name AS profession, p.city, p.state
         FROM agency_roster r JOIN professionals p ON p.id = r.professional_id JOIN users u ON u.id = p.user_id
         JOIN professions pr ON pr.id = p.profession_id
        WHERE r.agency_id = $1 AND r.status <> 'removed' ORDER BY r.created_at DESC, r.id`, [orgOf(req)]);
    res.json({ roster: rows });
  });

  /**
   * Invites an existing professional by email. The response is identical whether or not the address belongs to a
   * professional, so the roster feature cannot be used to discover who has an account.
   */
  r.post('/roster/invitations', validate({ params: orgParams, body: rosterInviteBody }), ...guard('agency.roster.manage'), requireApprovedOrg(deps), async (req, res) => {
    const agencyId = orgOf(req);
    // Checked before the lookup, so the answer reveals nothing about whether the email belongs to a professional.
    const [roster] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM agency_roster WHERE agency_id = $1 AND status IN ('invited','active')`, [agencyId]);
    await assertWithinCountLimit(deps, db, agencyId, 'agency_roster.limit', Number(roster?.n ?? 0));
    const [target] = await db.query<{ professional_id: string; user_id: string }>(
      `SELECT p.id AS professional_id, u.id AS user_id FROM users u JOIN professionals p ON p.user_id = u.id
        WHERE lower(u.email) = $1 AND u.status = 'active' AND p.account_status = 'active'`, [req.body.email]);
    if (target) {
      const row = await db.transaction(async (tx) => {
        const [existing] = await tx.query<{ id: string; status: string }>('SELECT id, status FROM agency_roster WHERE agency_id = $1 AND professional_id = $2 FOR UPDATE', [agencyId, target.professional_id]);
        if (existing && ['invited', 'active'].includes(existing.status)) return null;
        const [saved] = existing
          ? await tx.query<{ id: string }>(`UPDATE agency_roster SET status = 'invited', invited_by = $2, responded_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`, [existing.id, req.auth!.userId])
          : await tx.query<{ id: string }>('INSERT INTO agency_roster (agency_id, professional_id, invited_by) VALUES ($1,$2,$3) RETURNING id', [agencyId, target.professional_id, req.auth!.userId]);
        await audit(tx, { actorUserId: req.auth!.userId, action: 'agency.roster_invited', targetType: 'agency_roster', targetId: saved!.id, organizationId: agencyId, requestId: req.requestId });
        return saved!;
      });
      if (row) {
        const [agency] = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [agencyId]);
        await notifyUsers(deps, [target.user_id], {
          category: 'application_updates', type: 'agency.roster_invited', title: `${agency?.name ?? 'A staffing agency'} invited you to join its roster`,
          body: 'Accept to let the agency submit you for opportunities. You can leave at any time.', data: { rosterId: row.id },
        });
      }
    }
    res.status(202).json({ message: 'If this email belongs to a professional, an invitation has been sent.' });
  });

  r.delete('/roster/:rosterId', validate({ params: rosterParams }), ...guard('agency.roster.manage'), async (req, res) => {
    const rows = await db.query(
      `UPDATE agency_roster SET status = 'removed', updated_at = now() WHERE id = $1 AND agency_id = $2 AND status IN ('invited','active') RETURNING id`,
      [param(req, 'rosterId'), orgOf(req)]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'agency.roster_removed', targetType: 'agency_roster', targetId: param(req, 'rosterId'), organizationId: orgOf(req), requestId: req.requestId });
    res.status(204).end();
  });

  // ---- jobs the agency was granted access to
  r.get('/jobs', validate({ params: orgParams }), ...guard('agency.jobs.read'), async (req, res) => {
    const rows = await db.query(
      `SELECT j.id, j.title, j.employment_type, j.pay_min_cents, j.pay_max_cents, o.name AS facility_name, l.city, l.state, pr.name AS profession, ns.next_shift_at
         ${FROM_WHERE_BASE.replace('WHERE j.status', `JOIN job_agency_access ja ON ja.job_id = j.id AND ja.agency_id = $1 AND ja.status = 'active'\n  WHERE j.status`)}
        ORDER BY j.published_at DESC, j.id`, [orgOf(req)]);
    res.json({ jobs: rows });
  });

  r.get('/jobs/:jobId', validate({ params: orgJobParams }), ...guard('agency.jobs.read'), async (req, res) => {
    const [job] = await db.query<{ id: string }>(
      `SELECT j.id, j.title, j.description, j.employment_type, j.pay_min_cents, j.pay_max_cents, j.min_years_experience, o.name AS facility_name, l.city, l.state, pr.name AS profession, sp.name AS specialty
         ${FROM_WHERE_BASE.replace('WHERE j.status', `JOIN job_agency_access ja ON ja.job_id = j.id AND ja.agency_id = $2 AND ja.status = 'active'\n  WHERE j.status`)} AND j.id = $1`,
      [param(req, 'jobId'), orgOf(req)]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    const requirements = await db.query('SELECT kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1 ORDER BY mandatory DESC, kind', [job.id]);
    const shifts = await db.query(`SELECT id, starts_at, ends_at, hourly_rate_cents FROM shifts WHERE job_id = $1 AND status = 'open' AND starts_at > now() ORDER BY starts_at`, [job.id]);
    res.json({ job, requirements, shifts });
  });

  // ---- submissions (applications made on behalf of roster members)
  r.post('/jobs/:jobId/submissions', validate({ params: orgJobParams, body: submitBody }), ...guard('agency.submissions.manage'), requireApprovedOrg(deps), meterUsageMw(deps, 'agency_submissions.monthly_limit'), async (req, res) => {
    const agencyId = orgOf(req);
    const jobId = param(req, 'jobId');
    const b = req.body as z.infer<typeof submitBody>;
    const [job] = await db.query<{ id: string; organization_id: string; employment_type: string; title: string }>(
      `SELECT j.id, j.organization_id, j.employment_type, j.title
         ${FROM_WHERE_BASE.replace('WHERE j.status', `JOIN job_agency_access ja ON ja.job_id = j.id AND ja.agency_id = $2 AND ja.status = 'active'\n  WHERE j.status`)} AND j.id = $1`,
      [jobId, agencyId]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.'); // not granted, or not currently listable

    // Only consenting, active roster members of THIS agency can be submitted.
    const [member] = await db.query<{ professional_id: string; user_id: string; account_status: string }>(
      `SELECT p.id AS professional_id, p.user_id, p.account_status FROM agency_roster r JOIN professionals p ON p.id = r.professional_id
        WHERE r.agency_id = $1 AND r.professional_id = $2 AND r.status = 'active'`, [agencyId, b.professionalId]);
    if (!member) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (member.account_status !== 'active') throw new AppError('FORBIDDEN', 'This professional account is restricted.');

    const shiftIds = [...new Set(b.shiftIds ?? [])];
    if (shiftIds.length) {
      if (job.employment_type === 'permanent') throw new AppError('VALIDATION_FAILED', 'Permanent positions do not have shifts.', { fieldErrors: { shiftIds: ['Not applicable'] } });
      const ok = await db.query(`SELECT id FROM shifts WHERE id = ANY($1::uuid[]) AND job_id = $2 AND status = 'open' AND starts_at > now()`, [shiftIds, jobId]);
      if (ok.length !== shiftIds.length) throw new AppError('VALIDATION_FAILED', 'Choose open, upcoming shifts of this job.', { fieldErrors: { shiftIds: ['Invalid shift'] } });
    }
    // Same eligibility gate as a direct application: an agency can never submit around a mandatory requirement.
    const match = await evaluateMatch(db, { professionalId: member.professional_id, jobId, shiftIds, now: new Date(now()) });
    if (HARD_FAIL.includes(match.eligibility.outcome)) {
      throw new AppError('CONFLICT', 'This professional does not currently meet the mandatory requirements for this opportunity.',
        { outcome: match.eligibility.outcome, reasons: match.eligibility.reasons });
    }

    const app = await db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO applications (job_id, organization_id, professional_id, cover_note, submitted_by_agency_id, submitted_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [jobId, job.organization_id, member.professional_id, b.coverNote ?? null, agencyId, req.auth!.userId]);
      for (const sid of shiftIds) await tx.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3)', [row!.id, sid, job.organization_id]);
      await tx.query(`INSERT INTO application_events (application_id, actor_user_id, actor_kind, from_status, to_status) VALUES ($1,$2,'organization',NULL,'submitted')`, [row!.id, req.auth!.userId]);
      await snapshotMatch(tx, { applicationId: row!.id, organizationId: job.organization_id, jobId, professionalId: member.professional_id, trigger: 'apply', match });
      await audit(tx, { actorUserId: req.auth!.userId, action: 'agency.candidate_submitted', targetType: 'application', targetId: row!.id, organizationId: agencyId, requestId: req.requestId, metadata: { jobId, facilityId: job.organization_id } });
      return row!;
    });

    const [agency] = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [agencyId]);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, job.organization_id, 'applications.manage'), {
      category: 'application_updates', type: 'application.submitted', title: `New agency submission: ${job.title}`,
      body: `${agency?.name ?? 'An agency'} submitted a candidate. Eligibility: ${match.eligibility.outcome.replace(/_/g, ' ')}.`,
      data: { applicationId: app.id, jobId, organizationId: job.organization_id },
    });
    await notifyUsers(deps, [member.user_id], {
      category: 'application_updates', type: 'agency.submitted', title: `${agency?.name ?? 'Your agency'} submitted you for ${job.title}`,
      data: { applicationId: app.id, jobId },
    });
    res.status(201).json({ submission: { id: app.id, status: 'submitted' }, eligibility: { outcome: match.eligibility.outcome, reasons: match.eligibility.reasons } });
  });

  r.get('/submissions', validate({ params: orgParams }), ...guard('agency.submissions.read'), async (req, res) => {
    const q = z.object({ ...paging }).parse(req.query);
    const [count] = await db.query<{ n: string }>('SELECT count(*) AS n FROM applications WHERE submitted_by_agency_id = $1', [orgOf(req)]);
    const rows = await db.query(
      `SELECT a.id, a.status, a.created_at, a.updated_at, j.id AS job_id, j.title, fo.name AS facility_name, u.full_name AS candidate_name
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN organizations fo ON fo.id = a.organization_id
         JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id
        WHERE a.submitted_by_agency_id = $1 ORDER BY a.updated_at DESC, a.id LIMIT $2 OFFSET $3`,
      [orgOf(req), q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ submissions: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  /** Placements: confirmed work resulting from this agency's submissions. Rates are the agreed offer rate, in cents. */
  r.get('/placements', validate({ params: orgParams }), ...guard('agency.submissions.read'), async (req, res) => {
    const rows = await db.query(
      `SELECT asg.id, asg.status, asg.hourly_rate_cents, asg.created_at, s.starts_at, s.ends_at, j.title, fo.name AS facility_name, u.full_name AS candidate_name, t.status AS timesheet_status, t.minutes_worked
         FROM assignments asg LEFT JOIN timesheets t ON t.assignment_id = asg.id
         JOIN shift_offers so ON so.id = asg.offer_id
         JOIN applications a ON a.id = so.application_id AND a.submitted_by_agency_id = $1
         JOIN shifts s ON s.id = asg.shift_id JOIN jobs j ON j.id = s.job_id JOIN organizations fo ON fo.id = asg.organization_id
         JOIN professionals p ON p.id = asg.professional_id JOIN users u ON u.id = p.user_id
        ORDER BY s.starts_at DESC, asg.id LIMIT 200`, [orgOf(req)]);
    res.json({ placements: rows });
  });

  return r;
}

/** Facility-side agency access, mounted at /organizations/:orgId. */
export function facilityAgencyRoutes(deps: AppDeps) {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  const readJobs = requireOrgPermission(deps, 'jobs.read');
  const manageJobs = requireOrgPermission(deps, 'jobs.manage');
  const orgOf = (req: Request) => req.membership!.organizationId;

  // Approved agencies, by name. Only id and name are exposed.
  r.get('/agencies', validate({ params: orgParams }), readJobs, async (req, res) => {
    const q = searchQuery.parse(req.query);
    const args: unknown[] = [];
    let where = `type = 'agency' AND status = 'approved'`;
    if (q.q) { args.push(`%${escapeLike(q.q.toLowerCase())}%`); where += ` AND lower(name) LIKE $${args.length}`; }
    const rows = await db.query(`SELECT id, name FROM organizations WHERE ${where} ORDER BY name, id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ agencies: rows, page: q.page, pageSize: q.pageSize });
  });

  r.get('/jobs/:jobId/agencies', validate({ params: orgJobParams }), readJobs, async (req, res) => {
    const rows = await db.query(
      `SELECT ja.agency_id, o.name, ja.status, ja.created_at FROM job_agency_access ja JOIN organizations o ON o.id = ja.agency_id
        WHERE ja.job_id = $1 AND ja.organization_id = $2 ORDER BY ja.created_at`, [param(req, 'jobId'), orgOf(req)]);
    res.json({ agencies: rows });
  });

  r.post('/jobs/:jobId/agencies', validate({ params: orgJobParams, body: grantBody }), manageJobs, async (req, res) => {
    const jobId = param(req, 'jobId');
    const [job] = await db.query<{ title: string }>('SELECT title FROM jobs WHERE id = $1 AND organization_id = $2', [jobId, orgOf(req)]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [agency] = await db.query<{ id: string }>(`SELECT id FROM organizations WHERE id = $1 AND type = 'agency' AND status = 'approved'`, [req.body.agencyId]);
    if (!agency) throw new AppError('NOT_FOUND', 'Resource not found.');
    await db.query(
      `INSERT INTO job_agency_access (organization_id, job_id, agency_id, granted_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (job_id, agency_id) DO UPDATE SET status = 'active', granted_by = EXCLUDED.granted_by, updated_at = now()`,
      [orgOf(req), jobId, agency.id, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'job.agency_access_granted', targetType: 'job', targetId: jobId, organizationId: orgOf(req), requestId: req.requestId, metadata: { agencyId: agency.id } });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, agency.id, 'agency.jobs.read'), {
      category: 'application_updates', type: 'agency.job_access_granted', title: `You can now submit candidates for: ${job.title}`, data: { jobId },
    });
    res.status(201).json({ access: { jobId, agencyId: agency.id, status: 'active' } });
  });

  r.delete('/jobs/:jobId/agencies/:agencyId', validate({ params: orgJobAgencyParams }), manageJobs, async (req, res) => {
    const rows = await db.query(
      `UPDATE job_agency_access SET status = 'revoked', updated_at = now() WHERE job_id = $1 AND agency_id = $2 AND organization_id = $3 AND status = 'active' RETURNING id`,
      [param(req, 'jobId'), param(req, 'agencyId'), orgOf(req)]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'job.agency_access_revoked', targetType: 'job', targetId: param(req, 'jobId'), organizationId: orgOf(req), requestId: req.requestId, metadata: { agencyId: param(req, 'agencyId') } });
    res.status(204).end();
  });
  return r;
}

/** The professional's own agency relationships, mounted at /professionals/me. */
export function professionalAgencyRoutes(deps: AppDeps) {
  const { db } = deps;
  const r = Router();

  r.get('/agencies', async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const rows = await db.query(
      `SELECT r.id, r.status, r.created_at, o.name AS agency_name FROM agency_roster r JOIN organizations o ON o.id = r.agency_id
        WHERE r.professional_id = $1 AND r.status IN ('invited','active') ORDER BY r.created_at DESC`, [p.id]);
    res.json({ agencies: rows });
  });

  r.post('/agencies/:id/respond', validate({ params: idParams, body: respondBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const accept = req.body.response === 'accept';
    const [row] = await db.query<{ id: string; agency_id: string }>(
      `UPDATE agency_roster SET status = $3, responded_at = now(), updated_at = now()
        WHERE id = $1 AND professional_id = $2 AND status = 'invited' RETURNING id, agency_id`, [param(req, 'id'), p.id, accept ? 'active' : 'declined']);
    if (!row) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: `agency.roster_${accept ? 'accepted' : 'declined'}`, targetType: 'agency_roster', targetId: row.id, organizationId: row.agency_id, requestId: req.requestId });
    const [who] = await db.query<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [req.auth!.userId]);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, row.agency_id, 'agency.roster.manage'), {
      category: 'application_updates', type: `agency.roster_${accept ? 'accepted' : 'declined'}`,
      title: `${who?.full_name ?? 'A professional'} ${accept ? 'joined' : 'declined'} your roster`, data: { rosterId: row.id },
    });
    res.json({ agency: { id: row.id, status: accept ? 'active' : 'declined' } });
  });

  /** Leaving an agency is always allowed and takes effect immediately; existing applications are unaffected. */
  r.delete('/agencies/:id', validate({ params: idParams }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const rows = await db.query<{ agency_id: string }>(
      `UPDATE agency_roster SET status = 'removed', updated_at = now() WHERE id = $1 AND professional_id = $2 AND status IN ('invited','active') RETURNING agency_id`, [param(req, 'id'), p.id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'agency.roster_left', targetType: 'agency_roster', targetId: param(req, 'id'), organizationId: rows[0].agency_id, requestId: req.requestId });
    res.status(204).end();
  });
  return r;
}
