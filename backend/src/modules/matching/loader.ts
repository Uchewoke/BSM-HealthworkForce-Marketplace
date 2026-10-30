import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { EFFECTIVE_STATUS_SQL } from '../credentials/labels.js';
import { profileCompleteness } from '../professionals/service.js';
import { evaluateEligibility, type EligibilityResult } from './eligibility.js';
import { DEFAULT_WEIGHTS, rankCandidate, type RankResult, type Weights } from './ranking.js';

export const weightsSchema = z.object({
  specialty: z.number().int().min(0).max(100), experience: z.number().int().min(0).max(100), location: z.number().int().min(0).max(100),
  availability: z.number().int().min(0).max(100), compensation: z.number().int().min(0).max(100),
  workHistory: z.number().int().min(0).max(100), completeness: z.number().int().min(0).max(100),
}).strict().refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, 'Weights must add up to 100.');

export async function loadWeights(q: Queryable): Promise<{ weights: Weights; version: number }> {
  const [row] = await q.query<{ value: unknown; version: number }>(`SELECT value, version FROM platform_settings WHERE key = 'ranking_weights'`);
  const parsed = row ? weightsSchema.safeParse(row.value) : null;
  return parsed?.success ? { weights: parsed.data, version: row!.version } : { weights: { ...DEFAULT_WEIGHTS }, version: 0 };
}

export interface MatchResult { eligibility: EligibilityResult; rank: RankResult | null; weightsVersion: number }

const dateStr = (d: Date | string | null) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/**
 * Loads everything needed and runs Stage 1 (eligibility) then, only if eligible, Stage 2 (ranking).
 * `shiftIds` are the shifts the applicant selected; `excludeApplicationId` keeps an application from conflicting with itself.
 */
export async function evaluateMatch(q: Queryable, args: {
  professionalId: string; jobId: string; shiftIds: string[]; now: Date; excludeApplicationId?: string;
}): Promise<MatchResult> {
  const [prof] = await q.query<{ profession_id: string; account_status: string; state: string | null }>(
    'SELECT profession_id, account_status, state FROM professionals WHERE id = $1', [args.professionalId]);
  const [job] = await q.query<any>(
    `SELECT j.profession_id, j.specialty_id, j.min_years_experience, j.employment_type, j.pay_unit, j.pay_max_cents, l.timezone, l.state
       FROM jobs j JOIN facility_locations l ON l.id = j.location_id WHERE j.id = $1`, [args.jobId]);
  const specialtyIds = (await q.query<{ specialty_id: string }>('SELECT specialty_id FROM professional_specialties WHERE professional_id = $1', [args.professionalId])).map((r) => r.specialty_id);
  const experience = (await q.query<any>('SELECT start_date, end_date, specialty_id FROM professional_experience WHERE professional_id = $1', [args.professionalId]))
    .map((e) => ({ startDate: dateStr(e.start_date)!, endDate: dateStr(e.end_date), specialtyId: e.specialty_id as string | null }));
  const availability = (await q.query<any>(
    `SELECT day_of_week, to_char(start_time,'HH24:MI') AS s, to_char(end_time,'HH24:MI') AS e FROM professional_availability WHERE professional_id = $1`, [args.professionalId]))
    .map((w) => ({ dayOfWeek: Number(w.day_of_week), startTime: w.s as string, endTime: w.e as string }));
  const [prefs] = await q.query<any>(
    'SELECT employment_types, preferred_states, min_hourly_rate_cents, available_from FROM professional_preferences WHERE professional_id = $1', [args.professionalId]);
  const credentials = (await q.query<any>(
    `SELECT c.id, c.kind, c.credential_type, c.jurisdiction, ${EFFECTIVE_STATUS_SQL} AS effective_status, c.verification_method FROM credentials c WHERE c.professional_id = $1`, [args.professionalId]))
    .map((c) => ({ id: c.id, kind: c.kind, credentialType: c.credential_type, jurisdiction: c.jurisdiction, effectiveStatus: c.effective_status, verificationMethod: c.verification_method }));
  const requirements = (await q.query<any>('SELECT kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1', [args.jobId]))
    .map((r) => ({ kind: r.kind, credentialType: r.credential_type, jurisdiction: r.jurisdiction, description: r.description, mandatory: r.mandatory }));
  const shifts = args.shiftIds.length
    ? (await q.query<any>('SELECT id, starts_at, ends_at FROM shifts WHERE id = ANY($1::uuid[]) AND job_id = $2', [args.shiftIds, args.jobId]))
        .map((s) => ({ id: s.id as string, startsAt: new Date(s.starts_at), endsAt: new Date(s.ends_at) }))
    : [];
  const conflicts = (await q.query<any>(
    `SELECT s.starts_at, s.ends_at FROM application_shifts a JOIN applications app ON app.id = a.application_id
       JOIN shifts s ON s.id = a.shift_id
      WHERE app.professional_id = $1 AND app.status = 'accepted' AND ($2::uuid IS NULL OR app.id <> $2::uuid)`,
    [args.professionalId, args.excludeApplicationId ?? null])).map((s) => ({ startsAt: new Date(s.starts_at), endsAt: new Date(s.ends_at) }));

  const eligibility = evaluateEligibility({
    professional: { professionId: prof!.profession_id, accountStatus: prof!.account_status, specialtyIds, experience, availability, availableFrom: dateStr(prefs?.available_from ?? null) },
    credentials,
    job: { professionId: job.profession_id, specialtyId: job.specialty_id, minYearsExperience: job.min_years_experience, timezone: job.timezone, employmentType: job.employment_type },
    requirements, shifts, conflicts, now: args.now,
  });

  const { weights, version } = await loadWeights(q);
  if (eligibility.outcome !== 'eligible') return { eligibility, rank: null, weightsVersion: version };
  const completeness = await profileCompleteness(q, args.professionalId);
  const rank = rankCandidate({
    professional: {
      specialtyIds, homeState: prof!.state, completenessPercent: completeness.percent, experience,
      preferredStates: prefs?.preferred_states ?? [], employmentTypes: prefs?.employment_types ?? [], minHourlyRateCents: prefs?.min_hourly_rate_cents ?? null,
    },
    job: { specialtyId: job.specialty_id, minYearsExperience: job.min_years_experience, state: job.state, employmentType: job.employment_type, payUnit: job.pay_unit, payMaxCents: job.pay_max_cents },
    now: args.now,
  }, weights);
  return { eligibility, rank, weightsVersion: version };
}

/** Persists a decision-point snapshot so the result and the rule/weight versions can be reviewed later. */
export async function snapshotMatch(q: Queryable, a: {
  applicationId: string; organizationId: string; jobId: string; professionalId: string; trigger: 'apply' | 'offer' | 'accept'; match: MatchResult;
}) {
  await q.query(
    `INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, score, explanation, rules_version, weights_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11)`,
    [a.applicationId, a.organizationId, a.jobId, a.professionalId, a.trigger, a.match.eligibility.outcome, JSON.stringify(a.match.eligibility),
     a.match.rank?.score ?? null, a.match.rank ? JSON.stringify(a.match.rank) : null, a.match.eligibility.rulesVersion, a.match.weightsVersion]);
}
