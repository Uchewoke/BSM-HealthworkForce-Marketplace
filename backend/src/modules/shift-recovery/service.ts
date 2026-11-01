import type { Db } from '../../db/index.js';
import type { CoreDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { audit } from '../audit/service.js';
import { createShiftOffer, expireOffers } from '../applications/shift-offers-service.js';
import { createFloatRequest, expireFloatRequests } from '../exchange/service.js';
import { evaluateMatch } from '../matching/loader.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';

const CLOSED_APPLICATION = ['withdrawn', 'cancelled', 'declined', 'rejected'];
const MAX_SHIFTS_PER_ORG = 200;
const MAX_POOL_EVALUATED = 100;
const AUTO_MESSAGE = 'This shift is still open and you may be a good fit. This offer was sent automatically on the facility’s behalf.';

export interface RecoverySettings {
  enabled: boolean; max_outreach: number; offer_hours: number; escalate_hours: number; min_lead_hours: number; include_float_pool: boolean; enabled_by: string | null;
}
export const DEFAULT_SETTINGS: RecoverySettings = { enabled: false, max_outreach: 5, offer_hours: 12, escalate_hours: 48, min_lead_hours: 2, include_float_pool: true, enabled_by: null };

export async function loadSettings(db: Pick<Db, 'query'>, organizationId: string): Promise<RecoverySettings> {
  const [row] = await db.query<RecoverySettings>('SELECT enabled, max_outreach, offer_hours, escalate_hours, min_lead_hours, include_float_pool, enabled_by FROM shift_recovery_settings WHERE organization_id = $1', [organizationId]);
  return row ?? { ...DEFAULT_SETTINGS };
}

export interface RunSummary { organizations: number; shiftsChecked: number; offersSent: number; requestsSent: number; escalated: number }

interface ShiftRow { id: string; job_id: string; positions: number; starts_at: Date; hourly_rate_cents: number | null; title: string; state: string }
interface Candidate { professionalId: string; applicationId: string | null; score: number }
interface Pool { eligible: Candidate[]; pendingVerification: number; unavailable: number; ineligible: number; poolEligible: number }

/** Who could still be asked: eligible applicants first, then (if allowed) opted-in pool members, each best-ranked first. */
async function findCandidates(db: Db, org: { id: string; settings: RecoverySettings }, shift: ShiftRow, already: Set<string>, now: Date): Promise<Pool> {
  const result: Pool = { eligible: [], pendingVerification: 0, unavailable: 0, ineligible: 0, poolEligible: 0 };
  const tally = (outcome: string) => {
    if (outcome === 'pending_verification' || outcome === 'needs_review') result.pendingVerification++;
    else if (outcome === 'unavailable') result.unavailable++;
    else result.ineligible++;
  };
  const applicants = await db.query<{ application_id: string; professional_id: string }>(
    `SELECT a.id AS application_id, a.professional_id FROM applications a JOIN application_shifts x ON x.application_id = a.id AND x.shift_id = $1
      WHERE a.organization_id = $2 AND a.status <> ALL($3::text[]) ORDER BY a.created_at, a.id`, [shift.id, org.id, CLOSED_APPLICATION]);
  const seen = new Set<string>();
  const fromApplicants: Candidate[] = [];
  for (const a of applicants) {
    if (already.has(a.professional_id) || seen.has(a.professional_id)) continue;
    seen.add(a.professional_id);
    const m = await evaluateMatch(db, { professionalId: a.professional_id, jobId: shift.job_id, shiftIds: [shift.id], now, excludeApplicationId: a.application_id });
    if (m.eligibility.outcome === 'eligible') fromApplicants.push({ professionalId: a.professional_id, applicationId: a.application_id, score: m.rank?.score ?? 0 });
    else tally(m.eligibility.outcome);
  }
  const fromPool: Candidate[] = [];
  if (org.settings.include_float_pool) {
    const members = await db.query<{ professional_id: string }>(
      `SELECT DISTINCT m.professional_id FROM float_pool_members m JOIN exchange_regions r ON r.id = m.region_id AND r.active
         JOIN exchange_participants ep ON ep.region_id = r.id AND ep.organization_id = $1 AND ep.status = 'active'
         JOIN professionals p ON p.id = m.professional_id JOIN users u ON u.id = p.user_id
        WHERE m.status = 'active' AND $2 = ANY(r.states) AND p.account_status = 'active' AND u.status = 'active' LIMIT ${MAX_POOL_EVALUATED}`, [org.id, shift.state]);
    for (const p of members) {
      if (already.has(p.professional_id) || seen.has(p.professional_id)) continue;
      seen.add(p.professional_id);
      const m = await evaluateMatch(db, { professionalId: p.professional_id, jobId: shift.job_id, shiftIds: [shift.id], now });
      if (m.eligibility.outcome === 'eligible') { fromPool.push({ professionalId: p.professional_id, applicationId: null, score: m.rank?.score ?? 0 }); result.poolEligible++; }
      else tally(m.eligibility.outcome);
    }
  }
  const byScore = (a: Candidate, b: Candidate) => b.score - a.score;
  result.eligible = [...fromApplicants.sort(byScore), ...fromPool.sort(byScore)];
  return result;
}

const hoursText = (h: number) => (h < 48 ? `${Math.max(0, Math.round(h))} hours` : `${Math.round(h / 24)} days`);

/** What the facility could do about a shortage, based only on facts we know. Suggestions, not instructions. */
async function nextSteps(db: Db, org: { id: string; settings: RecoverySettings }, shift: ShiftRow, c: Pool, reasons: { noRate: boolean; tooLate: boolean; capReached: boolean }, hours: number) {
  const steps: string[] = [];
  if (reasons.noRate) steps.push('Set an hourly rate on the shift so offers can be sent.');
  if (reasons.tooLate) steps.push('The shift starts very soon: contact professionals you already know directly.');
  if (c.pendingVerification > 0) steps.push(`${c.pendingVerification} candidate(s) could work this shift once their credentials are verified or reviewed. Ask them to finish their credential steps.`);
  if (c.unavailable > 0) steps.push(`${c.unavailable} candidate(s) are unavailable at these times.`);
  if (reasons.capReached) steps.push(`Automatic outreach stopped at your limit of ${org.settings.max_outreach} offers for this shift. Raise the limit in recovery settings, or send offers yourself.`);
  const [participates] = await db.query('SELECT 1 FROM exchange_participants WHERE organization_id = $1 AND status = $2', [org.id, 'active']);
  const [regionExists] = await db.query('SELECT 1 FROM exchange_regions WHERE active AND $1 = ANY(states)', [shift.state]);
  if (!participates && regionExists) steps.push('Join your region’s exchange to reach professionals in the shared float pool.');
  else if (participates && !org.settings.include_float_pool) steps.push('Turn on float pool outreach in recovery settings to include opted-in professionals in your region.');
  const [granted] = await db.query('SELECT 1 FROM job_agency_access WHERE job_id = $1 AND status = $2', [shift.job_id, 'active']);
  const [agencies] = await db.query('SELECT 1 FROM organizations WHERE type = $1 AND status = $2', ['agency', 'approved']);
  if (!granted && agencies) steps.push('Share this job with staffing agencies so they can submit candidates.');
  if (c.eligible.length === 0 && !reasons.noRate) steps.push('Consider raising the hourly rate, or adding detail to the job, to attract more applicants.');
  steps.push(hours > 24 ? 'If it cannot be covered, reduce the number of positions or cancel the shift early so no one is left expecting it.' : 'If it cannot be covered, tell the people who were counting on this shift as soon as you can.');
  return steps;
}

async function processShift(deps: Pick<CoreDeps, 'db' | 'email'>, org: { id: string; settings: RecoverySettings; name: string }, shift: ShiftRow, now: Date, requestId: string, sum: RunSummary) {
  const { db } = deps;
  const [taken] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM assignments WHERE shift_id = $1 AND status IN ('confirmed','completed')`, [shift.id]);
  const open = shift.positions - Number(taken?.n ?? 0);
  const [row] = await db.query<{ status: string; escalated_at: Date | null }>('SELECT status, escalated_at FROM shift_recovery WHERE shift_id = $1', [shift.id]);
  if (open <= 0) {
    if (row && row.status === 'active') await db.query(`UPDATE shift_recovery SET status = 'filled', updated_at = now() WHERE shift_id = $1`, [shift.id]);
    return;
  }
  if (row?.status === 'stopped') return;

  const [live] = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM shift_offers WHERE shift_id = $1 AND status = 'sent' AND expires_at > $2) + (SELECT count(*) FROM float_requests WHERE shift_id = $1 AND status = 'pending' AND expires_at > $2) AS n`, [shift.id, now]);
  const [ended] = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM shift_offers WHERE shift_id = $1 AND status IN ('declined','expired')) + (SELECT count(*) FROM float_requests WHERE shift_id = $1 AND status IN ('declined','expired')) AS n`, [shift.id]);
  // Recovery begins once outreach has actually failed (declined or expired), or when the facility starts it by hand.
  if (!row) {
    if (Number(ended?.n ?? 0) === 0) return;
    await db.query(`INSERT INTO shift_recovery (shift_id, organization_id, started_by) VALUES ($1,$2,'auto')`, [shift.id, org.id]);
  } else if (row.status === 'filled') {
    await db.query(`UPDATE shift_recovery SET status = 'active', escalated_at = NULL, escalation = NULL, updated_at = now() WHERE shift_id = $1`, [shift.id]); // a cancellation reopened it
  }
  sum.shiftsChecked++;

  const hours = (new Date(shift.starts_at).getTime() - now.getTime()) / 3_600_000;
  const already = new Set((await db.query<{ professional_id: string }>(
    `SELECT professional_id FROM shift_offers WHERE shift_id = $1 UNION SELECT professional_id FROM float_requests WHERE shift_id = $1`, [shift.id])).map((r) => r.professional_id));
  const [made] = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM shift_offers WHERE shift_id = $1 AND origin = 'recovery') + (SELECT count(*) FROM float_requests WHERE shift_id = $1 AND origin = 'recovery') AS n`, [shift.id]);

  const s = org.settings;
  const reasons = { noRate: false, tooLate: false, capReached: Number(made?.n ?? 0) >= s.max_outreach };
  const candidates = await findCandidates(db, org, shift, already, now);
  let sent = 0;
  if (hours < s.min_lead_hours) reasons.tooLate = true;
  else if (shift.hourly_rate_cents == null) reasons.noRate = true;
  else {
    const budget = Math.min(open - Number(live?.n ?? 0), s.max_outreach - Number(made?.n ?? 0));
    for (const c of candidates.eligible.slice(0, Math.max(0, budget))) {
      try {
        if (c.applicationId) {
          const offer = await createShiftOffer(db, {
            organizationId: org.id, applicationId: c.applicationId, shiftId: shift.id, actorUserId: s.enabled_by!, hourlyRateCents: shift.hourly_rate_cents,
            message: AUTO_MESSAGE, expiresInHours: s.offer_hours, requestId, now, origin: 'recovery',
          });
          const [prof] = await db.query<{ user_id: string }>('SELECT user_id FROM professionals WHERE id = $1', [c.professionalId]);
          if (prof) await notifyUsers(deps, [prof.user_id], { category: 'application_updates', type: 'shift_offer.sent', title: `Shift offer: ${shift.title}`, body: 'A facility offered you a shift. Review it before it expires.', data: { offerId: offer.id, shiftId: shift.id } });
          await audit(db, { actorUserId: s.enabled_by!, action: 'shift_recovery.outreach', targetType: 'shift_offer', targetId: offer.id, organizationId: org.id, requestId, metadata: { shiftId: shift.id, kind: 'offer' } });
          sum.offersSent++;
        } else {
          const req = await createFloatRequest(deps, { organizationId: org.id, professionalId: c.professionalId, shiftId: shift.id, hourlyRateCents: shift.hourly_rate_cents, message: AUTO_MESSAGE, userId: s.enabled_by!, requestId, now, origin: 'recovery', ttlHours: s.offer_hours });
          await audit(db, { actorUserId: s.enabled_by!, action: 'shift_recovery.outreach', targetType: 'float_request', targetId: req.id, organizationId: org.id, requestId, metadata: { shiftId: shift.id, kind: 'float_request' } });
          sum.requestsSent++;
        }
        sent++;
      } catch (e) {
        // One person who can no longer be offered (a race, a daily cap) must not stop the rest. The next run will look again.
        logger.warn({ shiftId: shift.id, err: e instanceof AppError ? e.code : 'unknown' }, 'shift recovery skipped a candidate');
        if (e instanceof AppError && e.code === 'RATE_LIMITED') break;
      }
    }
    if (Number(made?.n ?? 0) + sent >= s.max_outreach) reasons.capReached = true;
  }

  const liveAfter = Number(live?.n ?? 0) + sent;
  const stalled = liveAfter === 0;
  const closeToStart = hours <= s.escalate_hours;
  if (!row?.escalated_at && (stalled || closeToStart)) {
    const [contacted] = await db.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM shift_offers WHERE shift_id = $1) AS offers, (SELECT count(*) FROM float_requests WHERE shift_id = $1) AS requests,
              (SELECT count(*) FROM shift_offers WHERE shift_id = $1 AND status = 'declined') + (SELECT count(*) FROM float_requests WHERE shift_id = $1 AND status = 'declined') AS declined,
              (SELECT count(*) FROM shift_offers WHERE shift_id = $1 AND status = 'expired') + (SELECT count(*) FROM float_requests WHERE shift_id = $1 AND status = 'expired') AS expired`, [shift.id]);
    const remaining = candidates.eligible.length - sent;
    const why: string[] = [];
    if (reasons.noRate) why.push('the shift has no hourly rate, so offers cannot be sent');
    else if (reasons.tooLate) why.push('the shift is too close to its start for new automatic offers');
    else if (reasons.capReached && remaining > 0) why.push(`automatic outreach reached your limit of ${s.max_outreach}`);
    else if (stalled && remaining <= 0) why.push('there is no one else eligible to ask');
    if (closeToStart && !stalled) why.push(`the shift starts in ${hoursText(hours)} and ${open} position(s) are still open`);
    const steps = await nextSteps(db, org, shift, { ...candidates, eligible: candidates.eligible.slice(sent) }, reasons, hours);
    const snapshot = {
      generatedAt: now.toISOString(), openPositions: open, positions: shift.positions, hoursToStart: Math.round(hours * 10) / 10, liveOutreach: liveAfter,
      outreach: { offers: Number(contacted?.offers ?? 0), floatRequests: Number(contacted?.requests ?? 0), declined: Number(contacted?.declined ?? 0), expired: Number(contacted?.expired ?? 0) },
      candidates: { eligibleNotContacted: Math.max(0, remaining), pendingVerification: candidates.pendingVerification, unavailable: candidates.unavailable, ineligible: candidates.ineligible },
      reasons: why, steps,
    };
    await db.query(`UPDATE shift_recovery SET escalated_at = $2, escalation = $3::jsonb, updated_at = now() WHERE shift_id = $1 AND escalated_at IS NULL`, [shift.id, now, JSON.stringify(snapshot)]);
    await audit(db, { actorUserId: s.enabled_by, action: 'shift_recovery.escalated', targetType: 'shift', targetId: shift.id, organizationId: org.id, requestId, metadata: { open, hours: snapshot.hoursToStart } });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, org.id, 'applications.manage'), {
      category: 'application_updates', type: 'shift_recovery.escalated', title: `Shift still unfilled: ${shift.title}, starts in ${hoursText(hours)}`,
      body: `${open} of ${shift.positions} position(s) open. ${why.length ? `Why: ${why.join('; ')}. ` : ''}Next steps: ${steps.slice(0, 3).join(' ')}`, data: { shiftId: shift.id, kind: 'shift_recovery' },
    });
    sum.escalated++;
  }
  await db.query('UPDATE shift_recovery SET last_run_at = $2, updated_at = now() WHERE shift_id = $1', [shift.id, now]);
}

/**
 * One pass of unfilled-shift recovery. For every organization that switched it on: shifts whose outreach ended without
 * filling them get offers sent to the next best eligible people (within the facility's limits), and shifts that still cannot
 * be filled are escalated to the facility once, with the shortage and suggested next steps. Eligibility is never relaxed.
 */
export async function runShiftRecovery(deps: Pick<CoreDeps, 'db' | 'email'>, opts: { now: Date; organizationId?: string; requestId?: string }): Promise<RunSummary> {
  const { db } = deps;
  const sum: RunSummary = { organizations: 0, shiftsChecked: 0, offersSent: 0, requestsSent: 0, escalated: 0 };
  const requestId = opts.requestId ?? 'shift-recovery';
  await expireOffers(db, opts.now);
  await expireFloatRequests(db, opts.now);
  const orgs = await db.query<RecoverySettings & { organization_id: string; name: string }>(
    `SELECT s.organization_id, o.name, s.enabled, s.max_outreach, s.offer_hours, s.escalate_hours, s.min_lead_hours, s.include_float_pool, s.enabled_by
       FROM shift_recovery_settings s JOIN organizations o ON o.id = s.organization_id AND o.status = 'approved'
      WHERE s.enabled AND s.enabled_by IS NOT NULL AND ($1::uuid IS NULL OR s.organization_id = $1::uuid)
        AND EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = s.organization_id AND m.user_id = s.enabled_by AND m.status = 'active' AND u.status = 'active')`, [opts.organizationId ?? null]);
  for (const o of orgs) {
    sum.organizations++;
    const org = { id: o.organization_id, name: o.name, settings: o as RecoverySettings };
    const shifts = await db.query<ShiftRow>(
      `SELECT s.id, s.job_id, s.positions, s.starts_at, s.hourly_rate_cents, j.title, l.state FROM shifts s JOIN jobs j ON j.id = s.job_id JOIN facility_locations l ON l.id = j.location_id
        WHERE s.organization_id = $1 AND s.status = 'open' AND s.starts_at > $2 AND j.status IN ('published','paused') ORDER BY s.starts_at LIMIT ${MAX_SHIFTS_PER_ORG}`, [org.id, opts.now]);
    for (const shift of shifts) {
      try { await processShift(deps, org, shift, opts.now, requestId, sum); }
      catch (e) { logger.error({ shiftId: shift.id, err: e instanceof Error ? e.name : 'unknown' }, 'shift recovery failed for a shift'); }
    }
    // Shifts that filled up since the last run.
    await db.query(`UPDATE shift_recovery SET status = 'filled', updated_at = now() WHERE organization_id = $1 AND status = 'active' AND shift_id IN (SELECT id FROM shifts WHERE status = 'filled')`, [org.id]);
  }
  return sum;
}

/** Starts (or restarts) recovery for one shift by hand, even if no outreach has failed yet. */
export async function startShiftRecovery(db: Db, input: { organizationId: string; shiftId: string; userId: string; requestId: string }) {
  const settings = await loadSettings(db, input.organizationId);
  if (!settings.enabled) throw new AppError('CONFLICT', 'Turn on unfilled-shift recovery in the settings first.');
  const [shift] = await db.query('SELECT 1 FROM shifts s JOIN jobs j ON j.id = s.job_id WHERE s.id = $1 AND s.organization_id = $2 AND s.status = $3 AND s.starts_at > now() AND j.status IN (\'published\',\'paused\')', [input.shiftId, input.organizationId, 'open']);
  if (!shift) throw new AppError('NOT_FOUND', 'Resource not found.');
  await db.query(
    `INSERT INTO shift_recovery (shift_id, organization_id, status, started_by) VALUES ($1,$2,'active','manual')
     ON CONFLICT (shift_id) DO UPDATE SET status = 'active', started_by = 'manual', escalated_at = NULL, escalation = NULL, updated_at = now()`, [input.shiftId, input.organizationId]);
  await audit(db, { actorUserId: input.userId, action: 'shift_recovery.started', targetType: 'shift', targetId: input.shiftId, organizationId: input.organizationId, requestId: input.requestId });
}

export async function stopShiftRecovery(db: Db, input: { organizationId: string; shiftId: string; userId: string; requestId: string }) {
  const rows = await db.query(`UPDATE shift_recovery SET status = 'stopped', updated_at = now() WHERE shift_id = $1 AND organization_id = $2 AND status <> 'stopped' RETURNING shift_id`, [input.shiftId, input.organizationId]);
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
  await audit(db, { actorUserId: input.userId, action: 'shift_recovery.stopped', targetType: 'shift', targetId: input.shiftId, organizationId: input.organizationId, requestId: input.requestId });
}
