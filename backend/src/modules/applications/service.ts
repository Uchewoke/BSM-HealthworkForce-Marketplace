import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { evaluateMatch, snapshotMatch, type MatchResult } from '../matching/loader.js';

export const APPLICATION_STATUSES = [
  'submitted', 'under_review', 'shortlisted', 'interview_requested', 'interviewed', 'offer_sent',
  'accepted', 'declined', 'withdrawn', 'rejected', 'cancelled',
] as const;
export type AppStatus = (typeof APPLICATION_STATUSES)[number];
export type ActorKind = 'professional' | 'organization';

interface Rule { to: AppStatus; actor: ActorKind; reasonRequired?: boolean; needsEligible?: 'offer' | 'accept' }

/**
 * Allowed transitions. Offers and acceptance require the candidate to be positively `eligible` at that moment;
 * nothing a facility, a ranking score or an AI suggestion says can skip that check.
 * `accepted` records the professional's acceptance only: assignments, timesheets and pay come in later releases.
 */
const RULES: Partial<Record<AppStatus, Rule[]>> = {
  submitted: [
    { to: 'under_review', actor: 'organization' }, { to: 'shortlisted', actor: 'organization' },
    { to: 'rejected', actor: 'organization', reasonRequired: true }, { to: 'withdrawn', actor: 'professional' },
  ],
  under_review: [
    { to: 'shortlisted', actor: 'organization' }, { to: 'interview_requested', actor: 'organization' },
    { to: 'rejected', actor: 'organization', reasonRequired: true }, { to: 'withdrawn', actor: 'professional' },
  ],
  shortlisted: [
    { to: 'interview_requested', actor: 'organization' }, { to: 'offer_sent', actor: 'organization', needsEligible: 'offer' },
    { to: 'rejected', actor: 'organization', reasonRequired: true }, { to: 'withdrawn', actor: 'professional' },
  ],
  interview_requested: [
    { to: 'interviewed', actor: 'organization' }, { to: 'rejected', actor: 'organization', reasonRequired: true },
    { to: 'withdrawn', actor: 'professional' },
  ],
  interviewed: [
    { to: 'offer_sent', actor: 'organization', needsEligible: 'offer' }, { to: 'rejected', actor: 'organization', reasonRequired: true },
    { to: 'withdrawn', actor: 'professional' },
  ],
  offer_sent: [
    { to: 'accepted', actor: 'professional', needsEligible: 'accept' }, { to: 'declined', actor: 'professional' },
    { to: 'cancelled', actor: 'organization', reasonRequired: true },
  ],
};

export const statusText = (s: string) => s.replace(/_/g, ' ');

export async function transitionApplication(db: Db, input: {
  applicationId: string; actorKind: ActorKind; actorUserId: string;
  /** Scope: the organization (facility actions) or the professional (own actions). Others get 404. */
  organizationId?: string; professionalId?: string;
  to: AppStatus; reason?: string; requestId: string; now: Date;
}) {
  return db.transaction(async (tx) => {
    const [app] = await tx.query<{
      id: string; status: AppStatus; job_id: string; organization_id: string; professional_id: string; title: string; job_status: string;
    }>(
      `SELECT a.id, a.status, a.job_id, a.organization_id, a.professional_id, j.title, j.status AS job_status
         FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.id = $1 AND ($2::uuid IS NULL OR a.organization_id = $2::uuid) AND ($3::uuid IS NULL OR a.professional_id = $3::uuid)
        FOR UPDATE OF a`,
      [input.applicationId, input.organizationId ?? null, input.professionalId ?? null]);
    if (!app) throw new AppError('NOT_FOUND', 'Resource not found.');
    const rule = RULES[app.status]?.find((r) => r.to === input.to && r.actor === input.actorKind);
    if (!rule) throw new AppError('CONFLICT', `Cannot change an application from ${statusText(app.status)} to ${statusText(input.to)}.`);
    if (rule.reasonRequired && !input.reason?.trim()) {
      throw new AppError('VALIDATION_FAILED', 'A reason is required.', { fieldErrors: { reason: ['Required'] } });
    }

    if (rule.needsEligible) {
      const [org] = await tx.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [app.organization_id]);
      if (org?.status !== 'approved') throw new AppError('FORBIDDEN', 'The organization must be approved.', { organizationStatus: org?.status });
      if (rule.needsEligible === 'offer' && !['published', 'paused'].includes(app.job_status)) {
        throw new AppError('CONFLICT', `Offers cannot be sent for a ${app.job_status} job.`);
      }
      const shiftIds = (await tx.query<{ shift_id: string }>('SELECT shift_id FROM application_shifts WHERE application_id = $1', [app.id])).map((s) => s.shift_id);
      const match = await evaluateMatch(tx, { professionalId: app.professional_id, jobId: app.job_id, shiftIds, now: input.now, excludeApplicationId: app.id });
      if (match.eligibility.outcome !== 'eligible') {
        throw new RefusedForEligibility(match, { applicationId: app.id, organizationId: app.organization_id, jobId: app.job_id, professionalId: app.professional_id, trigger: rule.needsEligible, to: input.to });
      }
      await snapshotMatch(tx, {
        applicationId: app.id, organizationId: app.organization_id, jobId: app.job_id, professionalId: app.professional_id,
        trigger: rule.needsEligible, match,
      });
    }
    await tx.query('UPDATE applications SET status = $2, updated_at = now() WHERE id = $1', [app.id, input.to]);
    await tx.query('INSERT INTO application_events (application_id, actor_user_id, actor_kind, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)',
      [app.id, input.actorUserId, input.actorKind, app.status, input.to, input.reason?.trim() ?? null]);
    await audit(tx, {
      actorUserId: input.actorUserId, action: `application.status.${input.to}`, targetType: 'application', targetId: app.id,
      organizationId: app.organization_id, requestId: input.requestId, metadata: { from: app.status, to: input.to },
    });
    return { id: app.id, status: input.to, previousStatus: app.status, organizationId: app.organization_id, jobId: app.job_id, professionalId: app.professional_id, jobTitle: app.title };
  }).catch(async (e) => {
    if (e instanceof RefusedForEligibility) {
      // The transaction rolled back, so record the refusal (and why) separately; it must stay reviewable.
      const c = e.context;
      await snapshotMatch(db, { applicationId: c.applicationId, organizationId: c.organizationId, jobId: c.jobId, professionalId: c.professionalId, trigger: c.trigger, match: e.match });
      await audit(db, { actorUserId: input.actorUserId, action: 'application.transition_refused_ineligible', targetType: 'application', targetId: c.applicationId, organizationId: c.organizationId, requestId: input.requestId, metadata: { to: c.to, outcome: e.match.eligibility.outcome } });
      throw new AppError('CONFLICT', 'The candidate is not currently eligible for this step.', { outcome: e.match.eligibility.outcome, reasons: e.match.eligibility.reasons });
    }
    throw e;
  });
}

/** Thrown inside the transaction to roll back the status change; carries what is needed to record the refusal afterwards. */
class RefusedForEligibility extends Error {
  constructor(
    readonly match: MatchResult,
    readonly context: { applicationId: string; organizationId: string; jobId: string; professionalId: string; trigger: 'offer' | 'accept'; to: string },
  ) { super('not eligible'); }
}