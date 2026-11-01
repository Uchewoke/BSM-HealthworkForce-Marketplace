import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { evaluateMatch, snapshotMatch, type MatchResult } from '../matching/loader.js';

export const OFFER_STATUSES = ['sent', 'accepted', 'declined', 'withdrawn', 'expired'] as const;
export const ASSIGNMENT_STATUSES = ['confirmed', 'completed', 'no_show', 'cancelled_by_facility', 'cancelled_by_professional'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type ActorKind = 'professional' | 'organization';

const CLOSED_APPLICATION = ['withdrawn', 'cancelled', 'declined', 'rejected'];
const OFFERABLE_JOB = ['published', 'paused'];
export const DEFAULT_OFFER_HOURS = 48;
/** A professional can take back an acceptance this soon after making it, with no reason needed and no mark against their record. */
export const UNDO_WINDOW_MINUTES = 5;

export const statusText = (s: string) => s.replace(/_/g, ' ');

/** Offers expire lazily: any read or transition first flips overdue `sent` offers to `expired`. */
export async function expireOffers(db: Pick<Db, 'query'>, now: Date) {
  await db.query(`UPDATE shift_offers SET status = 'expired', updated_at = now() WHERE status = 'sent' AND expires_at <= $1`, [now]);
}

async function requireApprovedOrg(tx: Pick<Db, 'query'>, organizationId: string) {
  const [org] = await tx.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [organizationId]);
  if (org?.status !== 'approved') throw new AppError('FORBIDDEN', 'The organization must be approved.', { organizationStatus: org?.status });
}

/** Thrown inside a transaction to roll it back; carries what is needed to record the refusal afterwards. */
class RefusedForEligibility extends Error {
  constructor(
    readonly match: MatchResult,
    readonly context: { applicationId: string; organizationId: string; jobId: string; professionalId: string; trigger: 'offer' | 'accept'; offerId?: string },
  ) { super('not eligible'); }
}

async function recordRefusal(db: Db, e: RefusedForEligibility, actorUserId: string, requestId: string, action: string): Promise<never> {
  const c = e.context;
  await snapshotMatch(db, { applicationId: c.applicationId, organizationId: c.organizationId, jobId: c.jobId, professionalId: c.professionalId, trigger: c.trigger, match: e.match });
  await audit(db, {
    actorUserId, action, targetType: c.offerId ? 'shift_offer' : 'application', targetId: c.offerId ?? c.applicationId,
    organizationId: c.organizationId, requestId, metadata: { outcome: e.match.eligibility.outcome },
  });
  throw new AppError('CONFLICT', 'The candidate is not currently eligible for this shift.', { outcome: e.match.eligibility.outcome, reasons: e.match.eligibility.reasons });
}

export async function createShiftOffer(db: Db, input: {
  organizationId: string; applicationId: string; shiftId: string; actorUserId: string;
  hourlyRateCents?: number; message?: string; expiresInHours?: number; requestId: string; now: Date; origin?: 'facility' | 'recovery';
}) {
  await expireOffers(db, input.now);
  return db.transaction(async (tx) => {
    const [app] = await tx.query<{ id: string; status: string; job_id: string; professional_id: string; job_status: string; title: string }>(
      `SELECT a.id, a.status, a.job_id, a.professional_id, j.status AS job_status, j.title
         FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.id = $1 AND a.organization_id = $2 FOR UPDATE OF a`, [input.applicationId, input.organizationId]);
    if (!app) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (CLOSED_APPLICATION.includes(app.status)) throw new AppError('CONFLICT', `Offers cannot be sent for a ${statusText(app.status)} application.`);
    if (!OFFERABLE_JOB.includes(app.job_status)) throw new AppError('CONFLICT', `Offers cannot be sent for a ${app.job_status} job.`);
    await requireApprovedOrg(tx, input.organizationId);

    const [shift] = await tx.query<{ id: string; status: string; starts_at: string; hourly_rate_cents: number | null }>(
      `SELECT s.id, s.status, s.starts_at, s.hourly_rate_cents FROM shifts s
         JOIN application_shifts x ON x.shift_id = s.id AND x.application_id = $1
        WHERE s.id = $2 AND s.organization_id = $3`, [app.id, input.shiftId, input.organizationId]);
    if (!shift) throw new AppError('VALIDATION_FAILED', 'Choose a shift the candidate applied for.', { fieldErrors: { shiftId: ['Invalid shift'] } });
    const startsAt = new Date(shift.starts_at);
    if (shift.status !== 'open' || startsAt <= input.now) throw new AppError('CONFLICT', 'Only open, upcoming shifts can be offered.');

    const rate = input.hourlyRateCents ?? shift.hourly_rate_cents;
    if (rate == null) throw new AppError('VALIDATION_FAILED', 'An hourly rate is required.', { fieldErrors: { hourlyRateCents: ['Required'] } });

    const [existing] = await tx.query('SELECT 1 FROM shift_offers WHERE application_id = $1 AND shift_id = $2 AND status = $3', [app.id, shift.id, 'sent']);
    if (existing) throw new AppError('CONFLICT', 'An offer for this shift is already pending.');

    const match = await evaluateMatch(tx, { professionalId: app.professional_id, jobId: app.job_id, shiftIds: [shift.id], now: input.now, excludeApplicationId: app.id });
    if (match.eligibility.outcome !== 'eligible') {
      throw new RefusedForEligibility(match, { applicationId: app.id, organizationId: input.organizationId, jobId: app.job_id, professionalId: app.professional_id, trigger: 'offer' });
    }
    await snapshotMatch(tx, { applicationId: app.id, organizationId: input.organizationId, jobId: app.job_id, professionalId: app.professional_id, trigger: 'offer', match });

    const wanted = new Date(input.now.getTime() + (input.expiresInHours ?? DEFAULT_OFFER_HOURS) * 3600_000);
    const expiresAt = wanted < startsAt ? wanted : startsAt;
    const [offer] = await tx.query<{ id: string }>(
      `INSERT INTO shift_offers (organization_id, shift_id, application_id, professional_id, hourly_rate_cents, message, expires_at, created_by, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.organizationId, shift.id, app.id, app.professional_id, rate, input.message?.trim() || null, expiresAt, input.actorUserId, input.origin ?? 'facility']);
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'shift_offer.sent', targetType: 'shift_offer', targetId: offer!.id,
      organizationId: input.organizationId, requestId: input.requestId, metadata: { shiftId: shift.id, applicationId: app.id },
    });
    return { id: offer!.id, status: 'sent' as const, professionalId: app.professional_id, jobTitle: app.title, shiftId: shift.id, expiresAt };
  }).catch((e) => {
    if (e instanceof RefusedForEligibility) return recordRefusal(db, e, input.actorUserId, input.requestId, 'shift_offer.refused_ineligible');
    throw e;
  });
}

export async function withdrawShiftOffer(db: Db, input: { organizationId: string; offerId: string; actorUserId: string; requestId: string; now: Date }) {
  await expireOffers(db, input.now);
  return db.transaction(async (tx) => {
    const [offer] = await tx.query<{ id: string; status: string; professional_id: string; shift_id: string }>(
      'SELECT id, status, professional_id, shift_id FROM shift_offers WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.offerId, input.organizationId]);
    if (!offer) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (offer.status !== 'sent') throw new AppError('CONFLICT', `A ${offer.status} offer cannot be withdrawn.`);
    await tx.query(`UPDATE shift_offers SET status = 'withdrawn', responded_at = now(), updated_at = now() WHERE id = $1`, [offer.id]);
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'shift_offer.withdrawn', targetType: 'shift_offer', targetId: offer.id,
      organizationId: input.organizationId, requestId: input.requestId,
    });
    return { id: offer.id, status: 'withdrawn' as const, professionalId: offer.professional_id };
  });
}

export async function respondToShiftOffer(db: Db, input: {
  offerId: string; professionalId: string; actorUserId: string; response: 'accepted' | 'declined'; requestId: string; now: Date;
}) {
  await expireOffers(db, input.now);
  return db.transaction(async (tx) => {
    const [offer] = await tx.query<{
      id: string; status: string; organization_id: string; shift_id: string; application_id: string; hourly_rate_cents: number; expires_at: string; job_id: string; title: string;
    }>(
      `SELECT o.id, o.status, o.organization_id, o.shift_id, o.application_id, o.hourly_rate_cents, o.expires_at, s.job_id, j.title
         FROM shift_offers o JOIN shifts s ON s.id = o.shift_id JOIN jobs j ON j.id = s.job_id
        WHERE o.id = $1 AND o.professional_id = $2 FOR UPDATE OF o`, [input.offerId, input.professionalId]);
    if (!offer) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (offer.status !== 'sent') throw new AppError('CONFLICT', `This offer is ${offer.status} and can no longer be answered.`);
    if (new Date(offer.expires_at) <= input.now) throw new AppError('CONFLICT', 'This offer has expired.');

    if (input.response === 'declined') {
      await tx.query(`UPDATE shift_offers SET status = 'declined', responded_at = now(), updated_at = now() WHERE id = $1`, [offer.id]);
      await audit(tx, { actorUserId: input.actorUserId, action: 'shift_offer.declined', targetType: 'shift_offer', targetId: offer.id, organizationId: offer.organization_id, requestId: input.requestId });
      return { offerId: offer.id, status: 'declined' as const, assignmentId: null, organizationId: offer.organization_id, jobTitle: offer.title, shiftId: offer.shift_id };
    }

    const [shift] = await tx.query<{ status: string; starts_at: string; positions: number }>(
      'SELECT status, starts_at, positions FROM shifts WHERE id = $1 FOR UPDATE', [offer.shift_id]);
    if (!shift || shift.status !== 'open' || new Date(shift.starts_at) <= input.now) throw new AppError('CONFLICT', 'This shift is no longer open.');
    const [taken] = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM assignments WHERE shift_id = $1 AND status IN ('confirmed','completed')`, [offer.shift_id]);
    if (Number(taken?.n ?? 0) >= shift.positions) throw new AppError('CONFLICT', 'This shift has already been filled.');

    const [app] = await tx.query<{ status: string; job_status: string }>(
      'SELECT a.status, j.status AS job_status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1', [offer.application_id]);
    if (!app || CLOSED_APPLICATION.includes(app.status)) throw new AppError('CONFLICT', 'The application for this offer is closed.');
    if (!OFFERABLE_JOB.includes(app.job_status)) throw new AppError('CONFLICT', `This job is ${app.job_status}.`);
    await requireApprovedOrg(tx, offer.organization_id);

    const match = await evaluateMatch(tx, { professionalId: input.professionalId, jobId: offer.job_id, shiftIds: [offer.shift_id], now: input.now, excludeApplicationId: offer.application_id });
    if (match.eligibility.outcome !== 'eligible') {
      throw new RefusedForEligibility(match, {
        applicationId: offer.application_id, organizationId: offer.organization_id, jobId: offer.job_id, professionalId: input.professionalId, trigger: 'accept', offerId: offer.id,
      });
    }
    await snapshotMatch(tx, { applicationId: offer.application_id, organizationId: offer.organization_id, jobId: offer.job_id, professionalId: input.professionalId, trigger: 'accept', match });

    await tx.query(`UPDATE shift_offers SET status = 'accepted', responded_at = now(), updated_at = now() WHERE id = $1`, [offer.id]);
    const [asg] = await tx.query<{ id: string }>(
      `INSERT INTO assignments (organization_id, shift_id, professional_id, offer_id, hourly_rate_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [offer.organization_id, offer.shift_id, input.professionalId, offer.id, offer.hourly_rate_cents]);
    await tx.query(
      `INSERT INTO assignment_status_history (assignment_id, actor_user_id, actor_kind, from_status, to_status) VALUES ($1,$2,'professional',NULL,'confirmed')`,
      [asg!.id, input.actorUserId]);
    if (Number(taken?.n ?? 0) + 1 >= shift.positions) {
      await tx.query(`UPDATE shifts SET status = 'filled', updated_at = now() WHERE id = $1`, [offer.shift_id]);
    }
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'shift_offer.accepted', targetType: 'assignment', targetId: asg!.id,
      organizationId: offer.organization_id, requestId: input.requestId, metadata: { offerId: offer.id, shiftId: offer.shift_id },
    });
    return { offerId: offer.id, status: 'accepted' as const, assignmentId: asg!.id, organizationId: offer.organization_id, jobTitle: offer.title, shiftId: offer.shift_id };
  }).catch((e) => {
    if (e instanceof RefusedForEligibility) return recordRefusal(db, e, input.actorUserId, input.requestId, 'shift_offer.accept_refused_ineligible');
    throw e;
  });
}

interface AssignmentRule { to: AssignmentStatus; actor: ActorKind; reasonRequired?: boolean; afterStart?: boolean; cancels?: boolean }
const ASSIGNMENT_RULES: AssignmentRule[] = [
  { to: 'completed', actor: 'organization', afterStart: true },
  { to: 'no_show', actor: 'organization', afterStart: true },
  { to: 'cancelled_by_facility', actor: 'organization', reasonRequired: true, cancels: true },
  { to: 'cancelled_by_professional', actor: 'professional', reasonRequired: true, cancels: true },
];

export async function transitionAssignment(db: Db, input: {
  assignmentId: string; actorKind: ActorKind; actorUserId: string; organizationId?: string; professionalId?: string;
  to: AssignmentStatus; reason?: string; requestId: string; now: Date;
  /** The professional is undoing an acceptance made a moment ago (see UNDO_WINDOW_MINUTES). */
  undo?: boolean;
}) {
  return db.transaction(async (tx) => {
    const [a] = await tx.query<{
      id: string; status: AssignmentStatus; organization_id: string; professional_id: string; shift_id: string; starts_at: string; shift_status: string; positions: number; title: string; created_at: string;
    }>(
      `SELECT a.id, a.status, a.created_at, a.organization_id, a.professional_id, a.shift_id, s.starts_at, s.status AS shift_status, s.positions, j.title
         FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id
        WHERE a.id = $1 AND ($2::uuid IS NULL OR a.organization_id = $2::uuid) AND ($3::uuid IS NULL OR a.professional_id = $3::uuid)
        FOR UPDATE OF a`, [input.assignmentId, input.organizationId ?? null, input.professionalId ?? null]);
    if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
    const rule = ASSIGNMENT_RULES.find((r) => r.to === input.to && r.actor === input.actorKind);
    if (!rule || a.status !== 'confirmed') throw new AppError('CONFLICT', `Cannot change an assignment from ${statusText(a.status)} to ${statusText(input.to)}.`);
    if (input.undo) {
      if (input.to !== 'cancelled_by_professional') throw new AppError('BAD_REQUEST', 'Only a professional\u2019s own acceptance can be undone.');
      if (input.now.getTime() - new Date(a.created_at).getTime() > UNDO_WINDOW_MINUTES * 60_000) {
        throw new AppError('CONFLICT', `The ${UNDO_WINDOW_MINUTES}-minute undo window has passed. You can still cancel this shift from your assignments with a reason.`);
      }
    } else if (rule.reasonRequired && !input.reason?.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required.', { fieldErrors: { reason: ['Required'] } });
    const started = new Date(a.starts_at) <= input.now;
    if (rule.afterStart && !started) throw new AppError('CONFLICT', 'This can only be recorded once the shift has started.');
    if (rule.cancels && started) throw new AppError('CONFLICT', 'A shift that has already started cannot be cancelled.');

    await tx.query('UPDATE assignments SET status = $2, undone_at = CASE WHEN $3 THEN $4::timestamptz END, updated_at = now() WHERE id = $1', [a.id, input.to, !!input.undo, input.now]);
    await tx.query(
      'INSERT INTO assignment_status_history (assignment_id, actor_user_id, actor_kind, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)',
      [a.id, input.actorUserId, input.actorKind, a.status, input.to, input.undo ? 'Undone within the undo window' : input.reason?.trim() ?? null]);
    if (rule.cancels && a.shift_status === 'filled') {
      await tx.query(`UPDATE shifts SET status = 'open', updated_at = now() WHERE id = $1 AND status = 'filled'`, [a.shift_id]);
    }
    await audit(tx, {
      actorUserId: input.actorUserId, action: input.undo ? 'assignment.undone' : `assignment.status.${input.to}`, targetType: 'assignment', targetId: a.id,
      organizationId: a.organization_id, requestId: input.requestId, metadata: { from: a.status, to: input.to },
    });
    return { id: a.id, status: input.to, previousStatus: a.status, organizationId: a.organization_id, professionalId: a.professional_id, shiftId: a.shift_id, jobTitle: a.title };
  });
}
