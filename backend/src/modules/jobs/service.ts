import type { Db, Queryable } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import type { JobStatus } from './schemas.js';

/** Allowed lifecycle transitions. Statuses are never set directly by clients. */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['paused', 'filled', 'closed', 'cancelled'],
  paused: ['published', 'closed', 'cancelled'],
  filled: [],
  closed: [],
  cancelled: [],
};

/** Editing of non-structural fields is allowed in these statuses. */
export const EDITABLE_JOB_STATUSES: JobStatus[] = ['draft', 'published', 'paused'];

export interface JobRow {
  id: string; organization_id: string; location_id: string; department_id: string | null; title: string; description: string;
  profession_id: string; specialty_id: string | null; employment_type: string; status: JobStatus; pay_unit: string;
  pay_min_cents: number | null; pay_max_cents: number | null; application_deadline: Date | null; positions_count: number;
  min_years_experience: number | null; no_credential_requirements: boolean;
}

/** Verifies every referenced record belongs to this organization / profession. Throws 422 with field errors. */
export async function resolveRefs(q: Queryable, orgId: string, r: {
  locationId: string; departmentId?: string | null; professionId: string; specialtyId?: string | null;
}) {
  const errors: Record<string, string[]> = {};
  const [loc] = await q.query(
    `SELECT 1 FROM facility_locations l JOIN facilities f ON f.id = l.facility_id
      WHERE l.id = $1 AND l.organization_id = $2 AND l.active AND f.active`, [r.locationId, orgId]);
  if (!loc) errors.locationId = ['Unknown or inactive location.'];
  if (r.departmentId) {
    const [d] = await q.query('SELECT 1 FROM departments WHERE id = $1 AND organization_id = $2 AND location_id = $3 AND active', [r.departmentId, orgId, r.locationId]);
    if (!d) errors.departmentId = ['Unknown or inactive department for this location.'];
  }
  const [p] = await q.query('SELECT 1 FROM professions WHERE id = $1 AND active', [r.professionId]);
  if (!p) errors.professionId = ['Unknown profession.'];
  if (r.specialtyId) {
    const [s] = await q.query('SELECT 1 FROM specialties WHERE id = $1 AND profession_id = $2 AND active', [r.specialtyId, r.professionId]);
    if (!s) errors.specialtyId = ['Specialty must belong to the selected profession.'];
  }
  if (Object.keys(errors).length) throw new AppError('VALIDATION_FAILED', 'Invalid reference.', { fieldErrors: errors });
}

/** Everything that must be true before a job may be shown to professionals. Returns the list of unmet items. */
export async function publishBlockers(q: Queryable, job: JobRow, nowMs: number): Promise<string[]> {
  const missing: string[] = [];
  if (job.description.trim().length < 20) missing.push('description');
  if (job.application_deadline && job.application_deadline.getTime() <= nowMs) missing.push('applicationDeadline');
  try {
    await resolveRefs(q, job.organization_id, {
      locationId: job.location_id, departmentId: job.department_id, professionId: job.profession_id, specialtyId: job.specialty_id,
    });
  } catch { missing.push('references'); }

  const [disabled] = await q.query(
    `SELECT 1 FROM facility_locations l JOIN state_configurations sc ON sc.state = l.state WHERE l.id = $1 AND NOT sc.enabled`, [job.location_id]);
  if (disabled) missing.push('state_not_enabled');

  const [req] = await q.query<{ n: string }>(
    `SELECT count(*) AS n FROM job_requirements WHERE job_id = $1 AND mandatory AND kind IN ('license','certification')`, [job.id]);
  const mandatory = Number(req?.n ?? 0);
  if (job.no_credential_requirements && mandatory > 0) missing.push('requirements_conflict');
  else if (!job.no_credential_requirements && mandatory === 0) missing.push('requirements');

  if (job.employment_type !== 'permanent') {
    const [s] = await q.query<{ n: string }>(
      `SELECT count(*) AS n FROM shifts WHERE job_id = $1 AND status = 'open' AND starts_at > $2`, [job.id, new Date(nowMs)]);
    if (Number(s?.n ?? 0) === 0) missing.push('shifts');
  }
  return missing;
}

export async function transitionJob(db: Db, input: {
  orgId: string; jobId: string; to: JobStatus; actorUserId: string; reason?: string; requestId: string; nowMs: number;
}) {
  return db.transaction(async (tx) => {
    const [job] = await tx.query<JobRow>('SELECT * FROM jobs WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.jobId, input.orgId]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (!TRANSITIONS[job.status].includes(input.to)) throw new AppError('CONFLICT', `Cannot change a ${job.status} job to ${input.to}.`);

    if (input.to === 'published') {
      const [org] = await tx.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [input.orgId]);
      if (org?.status !== 'approved') throw new AppError('FORBIDDEN', 'Your organization must be approved before publishing.', { organizationStatus: org?.status });
      const missing = await publishBlockers(tx, job, input.nowMs);
      if (missing.length) throw new AppError('VALIDATION_FAILED', 'This job cannot be published yet.', { missing });
    }
    const terminal = ['filled', 'closed', 'cancelled'].includes(input.to);
    await tx.query(
      `UPDATE jobs SET status = $2, updated_at = now(),
         published_at = CASE WHEN $2 = 'published' THEN coalesce(published_at, now()) ELSE published_at END,
         closed_at = CASE WHEN $3 THEN now() ELSE closed_at END WHERE id = $1`, [job.id, input.to, terminal]);
    if (input.to === 'closed' || input.to === 'cancelled') {
      await tx.query(`UPDATE shifts SET status = 'cancelled', updated_at = now() WHERE job_id = $1 AND status = 'open'`, [job.id]);
    }
    await tx.query('INSERT INTO job_events (job_id, actor_user_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)',
      [job.id, input.actorUserId, job.status, input.to, input.reason?.trim() ?? null]);
    await audit(tx, {
      actorUserId: input.actorUserId, action: `job.status.${input.to}`, targetType: 'job', targetId: job.id,
      organizationId: input.orgId, requestId: input.requestId, metadata: { from: job.status, to: input.to },
    });
    return { id: job.id, status: input.to, previousStatus: job.status };
  });
}
