import { Router, type Request } from 'express';
import { orgRoleCan } from '@bsm/permissions';
import type { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { buildInsert, buildSet } from '../../shared/sql.js';
import { audit } from '../audit/service.js';
import {
  EDITABLE_JOB_STATUSES, resolveRefs, transitionJob, type JobRow,
} from './service.js';
import {
  STRUCTURAL_FIELDS, checkJobRules, createJobBody, jobStatusBody, listQuery, params, requirementsBody, shiftBody, shiftPatchBody, updateJobBody,
} from './schemas.js';

const JOB_COLUMNS: Record<string, string> = {
  title: 'title', description: 'description', locationId: 'location_id', departmentId: 'department_id', professionId: 'profession_id',
  specialtyId: 'specialty_id', employmentType: 'employment_type', payUnit: 'pay_unit', payMinCents: 'pay_min_cents', payMaxCents: 'pay_max_cents',
  applicationDeadline: 'application_deadline', positionsCount: 'positions_count', minYearsExperience: 'min_years_experience',
  noCredentialRequirements: 'no_credential_requirements',
};
const JOB_RET = `id, title, description, location_id, department_id, profession_id, specialty_id, employment_type, status, pay_unit,
  pay_min_cents, pay_max_cents, application_deadline, positions_count, min_years_experience, no_credential_requirements, published_at, closed_at, created_at, updated_at`;
const SHIFT_RET = 'id, job_id, starts_at, ends_at, positions, hourly_rate_cents, notes, status, created_at';
const MAX_SHIFTS = 200;
const MAX_ADVANCE_MS = 2 * 365 * 24 * 3600_000;

/** Facility job management, mounted at /organizations/:orgId/jobs. Every query is scoped by organization_id. */
export function jobRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'jobs.read');
  const write = [requireOrgPermission(deps, 'jobs.manage'), requireApprovedOrg(deps)];
  const notFound = () => new AppError('NOT_FOUND', 'Resource not found.');
  const orgOf = (req: Request) => req.membership!.organizationId;
  const log = (req: Request, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit(db, { actorUserId: req.auth!.userId, action, targetType: 'job', targetId: id, organizationId: orgOf(req), requestId: req.requestId, metadata });

  async function loadJob(req: Request): Promise<JobRow> {
    const [job] = await db.query<JobRow>('SELECT * FROM jobs WHERE id = $1 AND organization_id = $2', [param(req, 'jobId'), orgOf(req)]);
    if (!job) throw notFound();
    return job;
  }

  r.get('/', validate({ params: params.org }), read, async (req, res) => {
    const q = listQuery.parse(req.query);
    const args: unknown[] = [orgOf(req)];
    let where = 'j.organization_id = $1';
    if (q.status) { args.push(q.status); where += ` AND j.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM jobs j WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${JOB_RET.split(',').map((c) => `j.${c.trim()}`).join(', ')}, l.name AS location_name, l.city, l.state,
              (SELECT count(*) FROM shifts s WHERE s.job_id = j.id AND s.status = 'open' AND s.starts_at > now()) AS open_upcoming_shifts
         FROM jobs j JOIN facility_locations l ON l.id = j.location_id
        WHERE ${where} ORDER BY j.updated_at DESC, j.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ jobs: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.post('/', validate({ params: params.org, body: createJobBody }), ...write, async (req, res) => {
    const b = req.body as z.infer<typeof createJobBody>;
    const rules = checkJobRules({ payUnit: b.payUnit ?? 'hour', payMinCents: b.payMinCents, payMaxCents: b.payMaxCents, applicationDeadline: b.applicationDeadline }, now());
    if (Object.keys(rules).length) throw new AppError('VALIDATION_FAILED', 'Invalid job.', { fieldErrors: rules });
    await resolveRefs(db, orgOf(req), b);
    const ins = buildInsert(JOB_COLUMNS, b, { organization_id: orgOf(req), created_by: req.auth!.userId });
    const job = await db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(`INSERT INTO jobs ${ins.sql} RETURNING ${JOB_RET}`, ins.values);
      await tx.query(`INSERT INTO job_events (job_id, actor_user_id, from_status, to_status) VALUES ($1,$2,NULL,'draft')`, [row!.id, req.auth!.userId]);
      return row!;
    });
    await log(req, 'job.created', job.id);
    res.status(201).json({ job });
  });

  r.get('/:jobId', validate({ params: params.job }), read, async (req, res) => {
    const job = await loadJob(req);
    const requirements = await db.query(
      'SELECT id, kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1 ORDER BY created_at, id', [job.id]);
    const shifts = await db.query(`SELECT ${SHIFT_RET} FROM shifts WHERE job_id = $1 ORDER BY starts_at`, [job.id]);
    const history = await db.query('SELECT from_status, to_status, reason, created_at FROM job_events WHERE job_id = $1 ORDER BY seq', [job.id]);
    const [full] = await db.query(`SELECT ${JOB_RET} FROM jobs WHERE id = $1`, [job.id]);
    res.json({ job: full, requirements, shifts, history });
  });

  r.patch('/:jobId', validate({ params: params.job, body: updateJobBody }), ...write, async (req, res) => {
    const job = await loadJob(req);
    const b = req.body as z.infer<typeof updateJobBody>;
    if (!EDITABLE_JOB_STATUSES.includes(job.status)) throw new AppError('CONFLICT', `A ${job.status} job cannot be edited.`);
    const frozen = STRUCTURAL_FIELDS.filter((k) => b[k] !== undefined);
    if (job.status !== 'draft' && frozen.length) {
      throw new AppError('CONFLICT', 'These fields can only be changed while the job is a draft.', { fields: frozen });
    }
    const merged = {
      payUnit: b.payUnit ?? job.pay_unit,
      payMinCents: b.payMinCents !== undefined ? b.payMinCents : job.pay_min_cents,
      payMaxCents: b.payMaxCents !== undefined ? b.payMaxCents : job.pay_max_cents,
      applicationDeadline: b.applicationDeadline, // only validated when being changed
    };
    const rules = checkJobRules(merged, now());
    if (Object.keys(rules).length) throw new AppError('VALIDATION_FAILED', 'Invalid job.', { fieldErrors: rules });
    await resolveRefs(db, orgOf(req), {
      locationId: b.locationId ?? job.location_id,
      departmentId: b.departmentId !== undefined ? b.departmentId : (b.locationId ? null : job.department_id),
      professionId: b.professionId ?? job.profession_id,
      specialtyId: b.specialtyId !== undefined ? b.specialtyId : (b.professionId ? null : job.specialty_id),
    });
    const body: Record<string, unknown> = { ...b };
    if (b.locationId && b.departmentId === undefined) body.departmentId = null; // department belongs to the old location
    if (b.professionId && b.specialtyId === undefined) body.specialtyId = null;
    const set = buildSet(JOB_COLUMNS, body, 3);
    const [row] = await db.query(`UPDATE jobs SET ${set!.sql}, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING ${JOB_RET}`, [job.id, orgOf(req), ...set!.values]);
    await log(req, 'job.updated', job.id, { fields: Object.keys(b) });
    res.json({ job: row });
  });

  // ---- requirements (draft only: they define eligibility, so they cannot change under applicants)
  r.put('/:jobId/requirements', validate({ params: params.job, body: requirementsBody }), ...write, async (req, res) => {
    const job = await loadJob(req);
    if (job.status !== 'draft') throw new AppError('CONFLICT', 'Requirements can only be changed while the job is a draft.');
    const { requirements } = req.body as z.infer<typeof requirementsBody>;
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM job_requirements WHERE job_id = $1', [job.id]);
      for (const q of requirements) {
        await tx.query(
          `INSERT INTO job_requirements (job_id, organization_id, kind, credential_type, jurisdiction, description, mandatory) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [job.id, orgOf(req), q.kind, q.credentialType ?? null, q.jurisdiction ?? null, q.description ?? null, q.mandatory]);
      }
    });
    await log(req, 'job.requirements_updated', job.id, { count: requirements.length });
    res.json({ requirements: await db.query('SELECT id, kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1 ORDER BY created_at, id', [job.id]) });
  });

  // ---- shifts
  r.post('/:jobId/shifts', validate({ params: params.job, body: shiftBody }), ...write, async (req, res) => {
    const job = await loadJob(req);
    if (job.employment_type === 'permanent') throw new AppError('CONFLICT', 'Permanent positions do not have shifts.');
    if (!EDITABLE_JOB_STATUSES.includes(job.status)) throw new AppError('CONFLICT', `Shifts cannot be added to a ${job.status} job.`);
    const b = req.body as z.infer<typeof shiftBody>;
    const start = new Date(b.startsAt).getTime();
    if (start <= now()) throw new AppError('VALIDATION_FAILED', 'A shift must start in the future.', { fieldErrors: { startsAt: ['Must be in the future.'] } });
    if (start > now() + MAX_ADVANCE_MS) throw new AppError('VALIDATION_FAILED', 'A shift cannot be more than two years ahead.', { fieldErrors: { startsAt: ['Too far ahead.'] } });
    const [{ n } = { n: '0' }] = await db.query<{ n: string }>('SELECT count(*) AS n FROM shifts WHERE job_id = $1', [job.id]);
    if (Number(n) >= MAX_SHIFTS) throw new AppError('CONFLICT', `A job can have at most ${MAX_SHIFTS} shifts.`);
    const [row] = await db.query(
      `INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions, hourly_rate_cents, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${SHIFT_RET}`,
      [job.id, orgOf(req), b.startsAt, b.endsAt, b.positions, b.hourlyRateCents ?? null, b.notes ?? null]);
    await log(req, 'shift.created', job.id);
    res.status(201).json({ shift: row });
  });

  r.patch('/:jobId/shifts/:shiftId', validate({ params: params.shift, body: shiftPatchBody }), ...write, async (req, res) => {
    const job = await loadJob(req);
    if (!EDITABLE_JOB_STATUSES.includes(job.status)) throw new AppError('CONFLICT', `Shifts of a ${job.status} job cannot be changed.`);
    const [shift] = await db.query<{ status: string }>('SELECT status FROM shifts WHERE id = $1 AND job_id = $2 AND organization_id = $3', [param(req, 'shiftId'), job.id, orgOf(req)]);
    if (!shift) throw notFound();
    if (shift.status !== 'open') throw new AppError('CONFLICT', `A ${shift.status} shift cannot be changed.`);
    const b = req.body as z.infer<typeof shiftPatchBody>;
    const timing = ['startsAt', 'endsAt', 'positions', 'hourlyRateCents'].filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (job.status !== 'draft' && timing.length) {
      throw new AppError('CONFLICT', 'Shift times, positions and pay can only be changed while the job is a draft. Cancel the shift and add a new one instead.', { fields: timing });
    }
    const cols = { startsAt: 'starts_at', endsAt: 'ends_at', positions: 'positions', hourlyRateCents: 'hourly_rate_cents', notes: 'notes', status: 'status' };
    const set = buildSet(cols, b, 4);
    const [row] = await db.query(
      `UPDATE shifts SET ${set!.sql}, updated_at = now() WHERE id = $1 AND job_id = $2 AND organization_id = $3 RETURNING ${SHIFT_RET}`,
      [param(req, 'shiftId'), job.id, orgOf(req), ...set!.values]); // DB CHECKs backstop time order and the 24h limit
    await log(req, b.status === 'cancelled' ? 'shift.cancelled' : 'shift.updated', job.id);
    res.json({ shift: row });
  });

  r.delete('/:jobId/shifts/:shiftId', validate({ params: params.shift }), ...write, async (req, res) => {
    const job = await loadJob(req);
    if (job.status !== 'draft') throw new AppError('CONFLICT', 'Shifts can only be deleted from a draft job. Cancel the shift instead.');
    const rows = await db.query('DELETE FROM shifts WHERE id = $1 AND job_id = $2 AND organization_id = $3 RETURNING id', [param(req, 'shiftId'), job.id, orgOf(req)]);
    if (!rows[0]) throw notFound();
    await log(req, 'shift.deleted', job.id);
    res.status(204).end();
  });

  // ---- lifecycle
  r.post('/:jobId/status', validate({ params: params.job, body: jobStatusBody }), requireOrgPermission(deps, 'jobs.manage'), async (req, res) => {
    const b = req.body as z.infer<typeof jobStatusBody>;
    if (b.to === 'published' && !orgRoleCan(req.membership!.role, 'jobs.publish')) {
      throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    }
    const out = await transitionJob(db, {
      orgId: orgOf(req), jobId: param(req, 'jobId'), to: b.to, actorUserId: req.auth!.userId, reason: b.reason, requestId: req.requestId, nowMs: now(),
    });
    res.json({ job: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  return r;
}
