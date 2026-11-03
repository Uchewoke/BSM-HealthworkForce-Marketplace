import { orgRoleCan } from '@bsm/permissions';
import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { talentRefFor } from '../talent/refs.js';
import { evaluateMatches, type MatchResult } from './loader.js';
import { RANKING_VERSION, facilityView } from './ranking.js';

export const MAX_APPLICANTS = 500;
export const MAX_TALENT = 300;
export const OUTCOME_ORDER = ['eligible', 'pending_verification', 'needs_review', 'unavailable', 'expired_credential', 'ineligible'] as const;
const CLOSED = ['withdrawn', 'cancelled', 'declined', 'rejected'];

export type Scope = 'applicants' | 'talent' | 'both';

interface Entry { professionalId: string; source: 'applicant' | 'talent'; applicationId: string | null; tie: string; match: MatchResult; rank: number | null }

/**
 * Evaluates and ranks candidates for one job and stores the result. This is advisory: it creates no application, offer or
 * invitation and cannot change any status. Eligibility is decided first by the same rules used everywhere else; only
 * `eligible` candidates are ranked, and a score never moves anyone past a mandatory requirement.
 */
export async function createMatchRun(db: Db, input: {
  organizationId: string; jobId: string; scope: Scope; shiftIds: string[]; userId: string; requestId: string; now: Date;
}) {
  const [job] = await db.query<{ profession_id: string; status: string; employment_type: string }>(
    'SELECT profession_id, status, employment_type FROM jobs WHERE id = $1 AND organization_id = $2', [input.jobId, input.organizationId]);
  if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
  if (!['published', 'paused'].includes(job.status)) throw new AppError('CONFLICT', `Matching is not available for a ${job.status} job.`);

  const shiftIds = [...new Set(input.shiftIds)];
  if (shiftIds.length) {
    if (job.employment_type === 'permanent') throw new AppError('VALIDATION_FAILED', 'Permanent positions do not have shifts.', { fieldErrors: { shiftIds: ['Not applicable'] } });
    const ok = await db.query(`SELECT id FROM shifts WHERE id = ANY($1::uuid[]) AND job_id = $2 AND status = 'open' AND starts_at > $3`, [shiftIds, input.jobId, input.now]);
    if (ok.length !== shiftIds.length) throw new AppError('VALIDATION_FAILED', 'Choose open, upcoming shifts of this job.', { fieldErrors: { shiftIds: ['Invalid shift'] } });
  }

  let truncated = false;
  const sources: { professionalId: string; source: 'applicant' | 'talent'; applicationId: string | null; tie: string; shiftIds: string[] }[] = [];

  if (input.scope !== 'talent') {
    const apps = await db.query<{ id: string; professional_id: string; created_at: Date }>(
      `SELECT id, professional_id, created_at FROM applications WHERE job_id = $1 AND organization_id = $2 AND status <> ALL($3::text[])
        ORDER BY created_at, id LIMIT ${MAX_APPLICANTS + 1}`, [input.jobId, input.organizationId, CLOSED]);
    if (apps.length > MAX_APPLICANTS) { truncated = true; apps.pop(); }
    const byApp = new Map<string, string[]>();
    if (apps.length) {
      for (const r of await db.query<{ application_id: string; shift_id: string }>('SELECT application_id, shift_id FROM application_shifts WHERE application_id = ANY($1::uuid[])', [apps.map((a) => a.id)])) {
        byApp.set(r.application_id, [...(byApp.get(r.application_id) ?? []), r.shift_id]);
      }
    }
    for (const a of apps) sources.push({ professionalId: a.professional_id, source: 'applicant', applicationId: a.id, tie: `${new Date(a.created_at).toISOString()}|${a.id}`, shiftIds: byApp.get(a.id) ?? [] });
  }
  if (input.scope !== 'applicants') {
    // Opted-in, active professionals of the job's profession who have not already applied (including those who withdrew or were
    // turned down) and who are not members of this organization. The same opt-in rule as talent search.
    const pool = await db.query<{ id: string }>(
      `SELECT p.id FROM professionals p JOIN users u ON u.id = p.user_id
        WHERE p.discoverable AND p.account_status = 'active' AND u.status = 'active' AND p.profession_id = $1
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = $2 AND a.professional_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = $3 AND m.user_id = p.user_id AND m.status = 'active')
        ORDER BY p.updated_at DESC, p.id LIMIT ${MAX_TALENT + 1}`, [job.profession_id, input.jobId, input.organizationId]);
    if (pool.length > MAX_TALENT) { truncated = true; pool.pop(); }
    for (const p of pool) sources.push({ professionalId: p.id, source: 'talent', applicationId: null, tie: p.id, shiftIds });
  }

  const matches = await evaluateMatches(db, {
    jobId: input.jobId, now: input.now,
    candidates: sources.map((s) => ({ professionalId: s.professionalId, shiftIds: s.shiftIds, excludeApplicationId: s.applicationId ?? undefined })),
  });
  const entries: Entry[] = sources.filter((s) => matches.has(s.professionalId)).map((s) => ({ ...s, match: matches.get(s.professionalId)!, rank: null }));
  const order = (e: Entry) => OUTCOME_ORDER.indexOf(e.match.eligibility.outcome);
  entries.sort((a, b) => order(a) - order(b) || (b.match.rank?.score ?? 0) - (a.match.rank?.score ?? 0) || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
  let n = 0;
  for (const e of entries) if (e.match.rank) e.rank = ++n;

  const first = entries[0]?.match;
  const rulesVersion = first?.eligibility.rulesVersion ?? 'eligibility-v1';
  const weightsVersion = first?.weightsVersion ?? 0;

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx.query<{ id: string }>(
      `INSERT INTO match_runs (organization_id, job_id, scope, shift_ids, requested_by, rules_version, ranking_version, weights_version, candidate_count, truncated)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9,$10) RETURNING id`,
      [input.organizationId, input.jobId, input.scope, shiftIds, input.userId, rulesVersion, RANKING_VERSION, weightsVersion, entries.length, truncated]);
    if (entries.length) {
      await tx.query(
        `INSERT INTO candidate_matches (run_id, application_id, organization_id, job_id, professional_id, trigger, source, rank, outcome, eligibility, score, explanation, rules_version, weights_version)
         SELECT $1, x.application_id, $2, $3, x.professional_id, 'recommend', x.source, x.rank, x.outcome, x.eligibility, x.score, x.explanation, $4, $5
           FROM jsonb_to_recordset($6::jsonb) AS x(application_id uuid, professional_id uuid, source text, rank int, outcome text, eligibility jsonb, score numeric, explanation jsonb)`,
        [run!.id, input.organizationId, input.jobId, rulesVersion, weightsVersion, JSON.stringify(entries.map((e) => ({
          application_id: e.applicationId, professional_id: e.professionalId, source: e.source, rank: e.rank, outcome: e.match.eligibility.outcome,
          eligibility: e.match.eligibility, score: e.match.rank?.score ?? null, explanation: e.match.rank,
        })))]);
    }
    const counts: Record<string, number> = {};
    for (const e of entries) counts[e.match.eligibility.outcome] = (counts[e.match.eligibility.outcome] ?? 0) + 1;
    await audit(tx, {
      actorUserId: input.userId, action: 'match.run', targetType: 'match_run', targetId: run!.id, organizationId: input.organizationId, requestId: input.requestId,
      metadata: { jobId: input.jobId, scope: input.scope, candidates: entries.length, truncated, outcomes: counts, rulesVersion, rankingVersion: RANKING_VERSION, weightsVersion },
    });
    return run!.id;
  });
  return { runId, summary: summarize(entries), candidateCount: entries.length, truncated };
}

function summarize(entries: Entry[]) {
  const outcomes: Record<string, number> = {};
  for (const e of entries) outcomes[e.match.eligibility.outcome] = (outcomes[e.match.eligibility.outcome] ?? 0) + 1;
  return outcomes;
}

const RUN_COLUMNS = `id, job_id, scope, shift_ids, rules_version, ranking_version, weights_version, candidate_count, truncated, created_at`;
const runView = (r: any) => ({
  id: r.id, jobId: r.job_id, scope: r.scope, shiftIds: r.shift_ids, rulesVersion: r.rules_version, rankingVersion: r.ranking_version,
  weightsVersion: r.weights_version, candidateCount: r.candidate_count, truncated: r.truncated, createdAt: r.created_at,
});

export async function listMatchRuns(db: Db, organizationId: string, jobId: string) {
  const [job] = await db.query('SELECT 1 FROM jobs WHERE id = $1 AND organization_id = $2', [jobId, organizationId]);
  if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
  const rows = await db.query(`SELECT ${RUN_COLUMNS} FROM match_runs WHERE organization_id = $1 AND job_id = $2 ORDER BY created_at DESC, id LIMIT 50`, [organizationId, jobId]);
  return rows.map(runView);
}

/**
 * One page of a stored run. Applicants are shown as they are in the normal application review. Talent stays anonymized
 * (ADR 0005): a per-organization reference and a card, never identity; anyone who has since opted out is left out.
 */
export async function readMatchRun(db: Db, input: { organizationId: string; role: string; runId: string; userId: string; requestId: string; group: 'eligible' | 'all'; page: number; pageSize: number }) {
  const [run] = await db.query<any>(`SELECT ${RUN_COLUMNS} FROM match_runs WHERE id = $1 AND organization_id = $2`, [input.runId, input.organizationId]);
  if (!run) throw new AppError('NOT_FOUND', 'Resource not found.');
  // Anonymous talent needs the same standing as talent search: the permission, and an approved organization.
  const [org] = await db.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [input.organizationId]);
  const includeTalent = orgRoleCan(input.role, 'professionals.search') && org?.status === 'approved';
  const visible = `m.run_id = $1 AND m.organization_id = $2 AND ($3::boolean IS FALSE OR m.outcome = 'eligible')
                   AND (m.source = 'applicant' OR ($4::boolean AND p.discoverable AND p.account_status = 'active' AND u.status = 'active'))`;
  const from = `FROM candidate_matches m JOIN professionals p ON p.id = m.professional_id JOIN users u ON u.id = p.user_id
                JOIN professions pr ON pr.id = p.profession_id LEFT JOIN applications a ON a.id = m.application_id`;
  const args = [input.runId, input.organizationId, input.group === 'eligible', includeTalent];
  const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n ${from} WHERE ${visible}`, args);
  const rows = await db.query<any>(
    `SELECT m.id, m.source, m.rank, m.score, m.outcome, m.eligibility, m.explanation, m.application_id, m.professional_id,
            a.status AS application_status, u.full_name, p.headline, p.city, p.state, pr.name AS profession
       ${from} WHERE ${visible}
      ORDER BY array_position($5::text[], m.outcome), m.rank NULLS LAST, m.id LIMIT $6 OFFSET $7`,
    [...args, [...OUTCOME_ORDER], input.pageSize, (input.page - 1) * input.pageSize]);

  const [all] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM candidate_matches WHERE run_id = $1 AND organization_id = $2`, [input.runId, input.organizationId]);
  const total = Number(count?.n ?? 0);
  // Only meaningful when talent is shown at all: it counts people who opted out since the run.
  const hiddenSinceRun = input.group === 'all' && includeTalent ? Number(all?.n ?? 0) - total : null;

  const talentIds = rows.filter((r) => r.source === 'talent').map((r) => r.professional_id as string);
  const specialties = new Map<string, string[]>();
  if (talentIds.length) {
    for (const s of await db.query<{ professional_id: string; name: string }>(
      'SELECT ps.professional_id, s.name FROM professional_specialties ps JOIN specialties s ON s.id = ps.specialty_id WHERE ps.professional_id = ANY($1::uuid[]) ORDER BY s.name', [talentIds])) {
      specialties.set(s.professional_id, [...(specialties.get(s.professional_id) ?? []), s.name]);
    }
  }

  const results = [];
  for (const r of rows) {
    const e = r.eligibility;
    const base = {
      resultId: r.id, source: r.source, rank: r.rank, score: r.score == null ? null : Number(r.score),
      eligibility: {
        outcome: r.outcome, reasons: (e.reasons ?? []).map((x: any) => ({ code: x.code, message: x.message })),
        // Credential ids stay internal: only the requirement, its result and how it was verified are shown.
        requirements: (e.requirements ?? []).map(({ credentialId: _id, ...rest }: any) => rest),
      },
      factors: facilityView(r.explanation)?.factors ?? null,
    };
    results.push(r.source === 'applicant'
      ? { ...base, applicationId: r.application_id, applicationStatus: r.application_status, applicant: { name: r.full_name, headline: r.headline, city: r.city, state: r.state } }
      : { ...base, talentRef: await talentRefFor(db, input.organizationId, r.professional_id),
          talent: { profession: r.profession, specialties: specialties.get(r.professional_id) ?? [], city: r.city, state: r.state, yearsExperience: e.experienceYears ?? null } });
  }
  await audit(db, { actorUserId: input.userId, action: 'match.run_viewed', targetType: 'match_run', targetId: input.runId, organizationId: input.organizationId, requestId: input.requestId, metadata: { group: input.group, page: input.page } });
  return {
    run: runView(run), results, page: input.page, pageSize: input.pageSize, total, hiddenSinceRun,
    note: 'Advisory only. Results were computed when the run was created and may be out of date: eligibility is checked again when someone applies and at every offer and acceptance. Only candidates with outcome "eligible" are ranked, and ranking never overrides a mandatory requirement.',
  };
}
