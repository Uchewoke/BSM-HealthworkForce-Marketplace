import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { EFFECTIVE_STATUS_SQL } from '../credentials/labels.js';
import { profileCompletenessPercents } from '../professionals/service.js';
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

export interface MatchCandidate {
  professionalId: string;
  /** Shifts this candidate selected (empty = job-level). */
  shiftIds?: string[];
  /** Keeps an application from conflicting with itself. */
  excludeApplicationId?: string;
}

const group = <T extends Record<string, any>>(rows: T[], key: string) => {
  const map = new Map<string, T[]>();
  for (const r of rows) map.set(r[key], [...(map.get(r[key]) ?? []), r]);
  return map;
};

/**
 * Loads everything needed for many candidates with one query per table, then runs Stage 1 (eligibility) and, only for
 * eligible candidates, Stage 2 (ranking). The rules are the same pure functions used for a single candidate.
 * Candidates that do not exist are absent from the result.
 */
export async function evaluateMatches(q: Queryable, args: { jobId: string; candidates: MatchCandidate[]; now: Date }): Promise<Map<string, MatchResult>> {
  const out = new Map<string, MatchResult>();
  const ids = [...new Set(args.candidates.map((c) => c.professionalId))];
  if (!ids.length) return out;
  const [job] = await q.query<any>(
    `SELECT j.profession_id, j.specialty_id, j.min_years_experience, j.employment_type, j.pay_unit, j.pay_max_cents, l.timezone, l.state
       FROM jobs j JOIN facility_locations l ON l.id = j.location_id WHERE j.id = $1`, [args.jobId]);
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  const requirements = (await q.query<any>('SELECT kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1', [args.jobId]))
    .map((r) => ({ kind: r.kind, credentialType: r.credential_type, jurisdiction: r.jurisdiction, description: r.description, mandatory: r.mandatory }));

  const profs = new Map((await q.query<{ id: string; profession_id: string; account_status: string; state: string | null }>(
    'SELECT id, profession_id, account_status, state FROM professionals WHERE id = ANY($1::uuid[])', [ids])).map((p) => [p.id, p]));
  const specialties = group(await q.query<{ professional_id: string; specialty_id: string }>('SELECT professional_id, specialty_id FROM professional_specialties WHERE professional_id = ANY($1::uuid[])', [ids]), 'professional_id');
  const experience = group(await q.query<any>('SELECT professional_id, start_date, end_date, specialty_id FROM professional_experience WHERE professional_id = ANY($1::uuid[])', [ids]), 'professional_id');
  const availability = group(await q.query<any>(
    `SELECT professional_id, day_of_week, to_char(start_time,'HH24:MI') AS s, to_char(end_time,'HH24:MI') AS e FROM professional_availability WHERE professional_id = ANY($1::uuid[])`, [ids]), 'professional_id');
  const prefs = new Map((await q.query<any>(
    'SELECT professional_id, employment_types, preferred_states, min_hourly_rate_cents, available_from FROM professional_preferences WHERE professional_id = ANY($1::uuid[])', [ids])).map((p) => [p.professional_id as string, p]));
  const credentials = group(await q.query<any>(
    `SELECT c.professional_id, c.id, c.kind, c.credential_type, c.jurisdiction, ${EFFECTIVE_STATUS_SQL} AS effective_status, c.verification_method FROM credentials c WHERE c.professional_id = ANY($1::uuid[])`, [ids]), 'professional_id');
  const conflicts = group(await q.query<any>(
    `SELECT app.professional_id, app.id AS application_id, s.starts_at, s.ends_at FROM application_shifts a JOIN applications app ON app.id = a.application_id
       JOIN shifts s ON s.id = a.shift_id WHERE app.professional_id = ANY($1::uuid[]) AND app.status = 'accepted'
     UNION ALL
     SELECT asg.professional_id, NULL AS application_id, s.starts_at, s.ends_at FROM assignments asg JOIN shifts s ON s.id = asg.shift_id
      WHERE asg.professional_id = ANY($1::uuid[]) AND asg.status = 'confirmed'`, [ids]), 'professional_id');

  const shiftIds = [...new Set(args.candidates.flatMap((c) => c.shiftIds ?? []))];
  const shiftRows = new Map((shiftIds.length
    ? await q.query<any>('SELECT id, starts_at, ends_at FROM shifts WHERE id = ANY($1::uuid[]) AND job_id = $2', [shiftIds, args.jobId]) : [])
    .map((s) => [s.id as string, { id: s.id as string, startsAt: new Date(s.starts_at), endsAt: new Date(s.ends_at) }]));

  const { weights, version } = await loadWeights(q);
  const completeness = await profileCompletenessPercents(q, ids);

  for (const cand of args.candidates) {
    const prof = profs.get(cand.professionalId);
    if (!prof || out.has(cand.professionalId)) continue;
    const id = cand.professionalId;
    const specialtyIds = (specialties.get(id) ?? []).map((r) => r.specialty_id);
    const exp = (experience.get(id) ?? []).map((e) => ({ startDate: dateStr(e.start_date)!, endDate: dateStr(e.end_date), specialtyId: e.specialty_id as string | null }));
    const windows = (availability.get(id) ?? []).map((w) => ({ dayOfWeek: Number(w.day_of_week), startTime: w.s as string, endTime: w.e as string }));
    const pref = prefs.get(id);
    const creds = (credentials.get(id) ?? []).map((c) => ({ id: c.id, kind: c.kind, credentialType: c.credential_type, jurisdiction: c.jurisdiction, effectiveStatus: c.effective_status, verificationMethod: c.verification_method }));
    const shifts = (cand.shiftIds ?? []).map((sid) => shiftRows.get(sid)).filter((s): s is NonNullable<typeof s> => !!s);
    const busy = (conflicts.get(id) ?? []).filter((c) => !cand.excludeApplicationId || c.application_id !== cand.excludeApplicationId)
      .map((c) => ({ startsAt: new Date(c.starts_at), endsAt: new Date(c.ends_at) }));

    const eligibility = evaluateEligibility({
      professional: { professionId: prof.profession_id, accountStatus: prof.account_status, specialtyIds, experience: exp, availability: windows, availableFrom: dateStr(pref?.available_from ?? null) },
      credentials: creds,
      job: { professionId: job.profession_id, specialtyId: job.specialty_id, minYearsExperience: job.min_years_experience, timezone: job.timezone, employmentType: job.employment_type },
      requirements, shifts, conflicts: busy, now: args.now,
    });
    if (eligibility.outcome !== 'eligible') { out.set(id, { eligibility, rank: null, weightsVersion: version }); continue; }
    const rank = rankCandidate({
      professional: {
        specialtyIds, homeState: prof.state, completenessPercent: completeness.get(id) ?? 0, experience: exp,
        preferredStates: pref?.preferred_states ?? [], employmentTypes: pref?.employment_types ?? [], minHourlyRateCents: pref?.min_hourly_rate_cents ?? null,
      },
      job: { specialtyId: job.specialty_id, minYearsExperience: job.min_years_experience, state: job.state, employmentType: job.employment_type, payUnit: job.pay_unit, payMaxCents: job.pay_max_cents },
      now: args.now,
    }, weights);
    out.set(id, { eligibility, rank, weightsVersion: version });
  }
  return out;
}

/**
 * One candidate: Stage 1 (eligibility) then, only if eligible, Stage 2 (ranking).
 * `shiftIds` are the shifts the applicant selected; `excludeApplicationId` keeps an application from conflicting with itself.
 */
export async function evaluateMatch(q: Queryable, args: {
  professionalId: string; jobId: string; shiftIds: string[]; now: Date; excludeApplicationId?: string;
}): Promise<MatchResult> {
  const m = (await evaluateMatches(q, { jobId: args.jobId, now: args.now, candidates: [{ professionalId: args.professionalId, shiftIds: args.shiftIds, excludeApplicationId: args.excludeApplicationId }] })).get(args.professionalId);
  if (!m) throw new Error(`Professional ${args.professionalId} not found`);
  return m;
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
