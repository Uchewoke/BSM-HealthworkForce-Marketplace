import type { Db, Queryable } from '../../db/index.js';
import type { CoreDeps } from '../../shared/deps.js';
import { notifyUsers } from '../notifications/service.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { statusLabel } from '../credentials/labels.js';
import { experienceYears } from '../matching/eligibility.js';
import { evaluateMatch } from '../matching/loader.js';
import { createShiftOffer, respondToShiftOffer } from '../applications/shift-offers-service.js';

export const MIN_COUNT_SHOWN = 5;
export const REQUEST_TTL_HOURS = 48;
export const DAILY_REQUESTS_PER_ORG = 40;
const OFFERABLE_JOB = ['published', 'paused'];
const CLOSED_APPLICATION = ['withdrawn', 'cancelled', 'declined', 'rejected'];

/** Anonymous card parts for pool members. Mirrors the talent-search contract: no name, contact, employer, school, pay or documents. */
export async function loadCardParts(q: Queryable, ids: string[], now: Date) {
  const specialties = new Map<string, string[]>(), experience = new Map<string, { startDate: string; endDate: string | null }[]>();
  const credentials = new Map<string, unknown[]>(), windows = new Map<string, { dayOfWeek: number; startTime: string; endTime: string }[]>();
  if (!ids.length) return { specialties, years: new Map<string, number>(), credentials, windows };
  for (const s of await q.query<{ professional_id: string; name: string }>(
    'SELECT ps.professional_id, s.name FROM professional_specialties ps JOIN specialties s ON s.id = ps.specialty_id WHERE ps.professional_id = ANY($1::uuid[]) ORDER BY s.name', [ids])) {
    specialties.set(s.professional_id, [...(specialties.get(s.professional_id) ?? []), s.name]);
  }
  for (const e of await q.query<{ professional_id: string; start_date: Date; end_date: Date | null }>(
    'SELECT professional_id, start_date, end_date FROM professional_experience WHERE professional_id = ANY($1::uuid[])', [ids])) {
    experience.set(e.professional_id, [...(experience.get(e.professional_id) ?? []), { startDate: new Date(e.start_date).toISOString().slice(0, 10), endDate: e.end_date ? new Date(e.end_date).toISOString().slice(0, 10) : null }]);
  }
  for (const c of await q.query<{ professional_id: string; kind: string; credential_type: string; jurisdiction: string | null; verification_method: string | null; effective_status: string }>(
    `SELECT c.professional_id, c.kind, c.credential_type, c.jurisdiction, c.verification_method,
            CASE WHEN c.status NOT IN ('revoked','rejected') AND c.expiration_date < CURRENT_DATE THEN 'expired' ELSE c.status END AS effective_status
       FROM credentials c WHERE c.professional_id = ANY($1::uuid[]) AND c.status <> 'not_submitted' ORDER BY c.kind, c.credential_type`, [ids])) {
    credentials.set(c.professional_id, [...(credentials.get(c.professional_id) ?? []),
      { kind: c.kind, credentialType: c.credential_type, jurisdiction: c.jurisdiction, status: c.effective_status, statusLabel: statusLabel(c.effective_status, c.verification_method) }]);
  }
  for (const w of await q.query<{ professional_id: string; day_of_week: number; start_time: string; end_time: string }>(
    'SELECT professional_id, day_of_week, start_time, end_time FROM professional_availability WHERE professional_id = ANY($1::uuid[]) ORDER BY day_of_week, start_time', [ids])) {
    windows.set(w.professional_id, [...(windows.get(w.professional_id) ?? []), { dayOfWeek: Number(w.day_of_week), startTime: String(w.start_time).slice(0, 5), endTime: String(w.end_time).slice(0, 5) }]);
  }
  return { specialties, years: new Map(ids.map((id) => [id, experienceYears(experience.get(id) ?? [], now)])), credentials, windows };
}

/** Marks overdue pending requests as expired. Called before every read or answer, like offers. */
export async function expireFloatRequests(q: Queryable, now: Date) {
  await q.query(`UPDATE float_requests SET status = 'expired', responded_at = $1 WHERE status = 'pending' AND expires_at <= $1`, [now]);
}

/** The region(s) that cover a state and in which the organization participates. */
export async function sharedRegion(q: Queryable, organizationId: string, professionalId: string, state: string): Promise<string | null> {
  const [r] = await q.query<{ id: string }>(
    `SELECT r.id FROM exchange_regions r
       JOIN exchange_participants ep ON ep.region_id = r.id AND ep.organization_id = $1 AND ep.status = 'active'
       JOIN float_pool_members m ON m.region_id = r.id AND m.professional_id = $2 AND m.status = 'active'
      WHERE r.active AND $3 = ANY(r.states) ORDER BY r.name LIMIT 1`, [organizationId, professionalId, state]);
  return r?.id ?? null;
}

/**
 * The professional accepts a float request. Everything that could refuse them is checked first, BEFORE their identity
 * becomes visible to the facility (creating the application reveals it). Then the normal offer and acceptance code books
 * the shift, so its eligibility, conflict and capacity rules apply unchanged.
 */
export async function acceptFloatRequest(db: Db, input: { requestId: string; professionalId: string; userId: string; httpRequestId: string; now: Date }) {
  await expireFloatRequests(db, input.now);
  const [claimed] = await db.query<{ id: string; organization_id: string; region_id: string; shift_id: string; hourly_rate_cents: number; message: string | null; created_by: string }>(
    `UPDATE float_requests SET responded_at = $3 WHERE id = $1 AND professional_id = $2 AND status = 'pending' AND responded_at IS NULL
      RETURNING id, organization_id, region_id, shift_id, hourly_rate_cents, message, created_by`, [input.requestId, input.professionalId, input.now]);
  if (!claimed) throw new AppError('NOT_FOUND', 'Resource not found.');

  const fail = async (message: string, details?: unknown): Promise<never> => {
    await db.query(`UPDATE float_requests SET status = 'failed', failure_reason = $2 WHERE id = $1`, [claimed.id, message]);
    throw new AppError('CONFLICT', message, details);
  };

  // ---- pre-flight: nothing here reveals the professional to the facility
  const [region] = await db.query<{ states: string[]; active: boolean }>('SELECT states, active FROM exchange_regions WHERE id = $1', [claimed.region_id]);
  const [member] = await db.query('SELECT 1 FROM float_pool_members WHERE region_id = $1 AND professional_id = $2 AND status = $3', [claimed.region_id, input.professionalId, 'active']);
  const [part] = await db.query('SELECT 1 FROM exchange_participants WHERE region_id = $1 AND organization_id = $2 AND status = $3', [claimed.region_id, claimed.organization_id, 'active']);
  if (!region?.active || !member || !part) return fail('This request is no longer available.');
  const [org] = await db.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [claimed.organization_id]);
  if (org?.status !== 'approved') return fail('This facility is not currently able to book shifts.');
  const [shift] = await db.query<{ job_id: string; status: string; starts_at: Date; positions: number; job_status: string; title: string }>(
    `SELECT s.job_id, s.status, s.starts_at, s.positions, j.status AS job_status, j.title FROM shifts s JOIN jobs j ON j.id = s.job_id WHERE s.id = $1`, [claimed.shift_id]);
  if (!shift || shift.status !== 'open' || new Date(shift.starts_at) <= input.now || !OFFERABLE_JOB.includes(shift.job_status)) return fail('This shift is no longer open.');
  const [taken] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM assignments WHERE shift_id = $1 AND status IN ('confirmed','completed')`, [claimed.shift_id]);
  if (Number(taken?.n ?? 0) >= shift.positions) return fail('This shift has already been filled.');
  const match = await evaluateMatch(db, { professionalId: input.professionalId, jobId: shift.job_id, shiftIds: [claimed.shift_id], now: input.now });
  if (match.eligibility.outcome !== 'eligible') {
    return fail('You do not currently meet the requirements for this shift.', { outcome: match.eligibility.outcome, reasons: match.eligibility.reasons });
  }

  // ---- book it through the normal path
  let applicationId: string | null = null;
  try {
    const [existing] = await db.query<{ id: string; status: string }>('SELECT id, status FROM applications WHERE job_id = $1 AND professional_id = $2', [shift.job_id, input.professionalId]);
    if (existing && CLOSED_APPLICATION.includes(existing.status)) return fail('You have a closed application for this job, so it cannot be booked through the pool.');
    applicationId = existing?.id ?? (await db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO applications (job_id, organization_id, professional_id, source) VALUES ($1,$2,$3,'float_pool') RETURNING id`, [shift.job_id, claimed.organization_id, input.professionalId]);
      await tx.query(`INSERT INTO application_events (application_id, actor_user_id, actor_kind, from_status, to_status, reason) VALUES ($1,$2,'professional',NULL,'submitted','Accepted a regional float request')`, [row!.id, input.userId]);
      return row!.id;
    }));
    await db.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [applicationId, claimed.shift_id, claimed.organization_id]);

    const offer = await createShiftOffer(db, {
      organizationId: claimed.organization_id, applicationId, shiftId: claimed.shift_id, actorUserId: claimed.created_by,
      hourlyRateCents: claimed.hourly_rate_cents, message: claimed.message ?? undefined, requestId: input.httpRequestId, now: input.now,
    });
    const accepted = await respondToShiftOffer(db, { offerId: offer.id, professionalId: input.professionalId, actorUserId: input.userId, response: 'accepted', requestId: input.httpRequestId, now: input.now });
    await db.query(`UPDATE float_requests SET status = 'accepted', application_id = $2, offer_id = $3 WHERE id = $1`, [claimed.id, applicationId, offer.id]);
    await audit(db, { actorUserId: input.userId, action: 'float_request.accepted', targetType: 'float_request', targetId: claimed.id, organizationId: claimed.organization_id, requestId: input.httpRequestId, metadata: { assignmentId: accepted.assignmentId } });
    return { organizationId: claimed.organization_id, assignmentId: accepted.assignmentId, jobTitle: shift.title, shiftId: claimed.shift_id, createdBy: claimed.created_by };
  } catch (e) {
    // Something changed between the checks and the booking (for example another person took the last position). Undo what we
    // created so the facility is not left with a stray application, then report it.
    if (applicationId) {
      await db.query(`UPDATE shift_offers SET status = 'withdrawn', responded_at = now() WHERE application_id = $1 AND status = 'sent'`, [applicationId]);
      await db.query(`UPDATE applications SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND status = 'submitted'`, [applicationId]);
    }
    const message = e instanceof AppError ? e.message : 'The shift could not be booked.';
    await db.query(`UPDATE float_requests SET status = 'failed', failure_reason = $2 WHERE id = $1`, [claimed.id, message]);
    throw e instanceof AppError ? e : new AppError('CONFLICT', message);
  }
}

/**
 * Validates and sends one float request: the shift must be open and in a region both sides share, the person must be
 * eligible for it right now, and the organization's daily cap applies. Used by the facility's request button and by
 * unfilled-shift recovery, so both obey exactly the same rules.
 */
export async function createFloatRequest(deps: Pick<CoreDeps, 'db' | 'email'>, input: {
  organizationId: string; professionalId: string; shiftId: string; hourlyRateCents?: number; message?: string;
  userId: string; requestId: string; now: Date; origin?: 'facility' | 'recovery'; ttlHours?: number;
}) {
  const { db } = deps;
  await expireFloatRequests(db, input.now);
  const [shift] = await db.query<{ job_id: string; status: string; starts_at: Date; hourly_rate_cents: number | null; state: string; title: string }>(
    `SELECT s.job_id, s.status, s.starts_at, s.hourly_rate_cents, l.state, j.title FROM shifts s JOIN jobs j ON j.id = s.job_id JOIN facility_locations l ON l.id = j.location_id
      WHERE s.id = $1 AND s.organization_id = $2 AND j.status IN ('published','paused')`, [input.shiftId, input.organizationId]);
  if (!shift) throw new AppError('NOT_FOUND', 'Resource not found.');
  if (shift.status !== 'open' || new Date(shift.starts_at) <= input.now) throw new AppError('CONFLICT', 'Only open, upcoming shifts can be requested.');
  const rate = input.hourlyRateCents ?? shift.hourly_rate_cents;
  if (rate == null) throw new AppError('VALIDATION_FAILED', 'An hourly rate is required.', { fieldErrors: { hourlyRateCents: ['Required'] } });
  const regionId = await sharedRegion(db, input.organizationId, input.professionalId, shift.state);
  if (!regionId) throw new AppError('CONFLICT', 'This professional is not in a pool you participate in for this shift’s region.');
  const match = await evaluateMatch(db, { professionalId: input.professionalId, jobId: shift.job_id, shiftIds: [input.shiftId], now: input.now });
  if (match.eligibility.outcome !== 'eligible') {
    throw new AppError('CONFLICT', 'This professional does not currently meet the requirements for this shift.', { outcome: match.eligibility.outcome, reasons: match.eligibility.reasons.map((x) => ({ code: x.code, message: x.message })) });
  }
  const [today] = await db.query<{ n: string }>('SELECT count(*) AS n FROM float_requests WHERE organization_id = $1 AND created_at > $2', [input.organizationId, new Date(input.now.getTime() - 86_400_000)]);
  if (Number(today?.n ?? 0) >= DAILY_REQUESTS_PER_ORG) throw new AppError('RATE_LIMITED', 'Daily request limit reached. Try again tomorrow.');
  const expiresAt = new Date(Math.min(input.now.getTime() + (input.ttlHours ?? REQUEST_TTL_HOURS) * 3600_000, new Date(shift.starts_at).getTime()));
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO float_requests (organization_id, region_id, shift_id, professional_id, hourly_rate_cents, message, created_by, expires_at, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [input.organizationId, regionId, input.shiftId, input.professionalId, rate, input.message ?? null, input.userId, expiresAt, input.origin ?? 'facility']);
  await audit(db, { actorUserId: input.userId, action: 'float_request.sent', targetType: 'float_request', targetId: row!.id, organizationId: input.organizationId, requestId: input.requestId, metadata: { shiftId: input.shiftId, regionId, origin: input.origin ?? 'facility' } });
  const [prof] = await db.query<{ user_id: string }>('SELECT user_id FROM professionals WHERE id = $1', [input.professionalId]);
  const [org] = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [input.organizationId]);
  if (prof) {
    await notifyUsers(deps, [prof.user_id], {
      category: 'application_updates', type: 'float_request.sent', title: `${org?.name ?? 'A facility'} asked you to cover a shift: ${shift.title}`,
      body: 'Your identity is shared with them only if you accept.', data: { floatRequestId: row!.id },
    });
  }
  return { id: row!.id, expiresAt };
}
