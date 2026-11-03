import { z } from 'zod';
import type { Db, Queryable } from '../../db/index.js';
import { withLease } from '../../shared/lease.js';
import { logger } from '../../shared/logger.js';
import { audit } from '../audit/service.js';

/**
 * Retention and erasure of match-run data (ADR 0009). Everything here concerns advisory match runs and the anonymous
 * references used to show talent. It never touches applications, offers, assignments, credentials, accounts or audit logs, and
 * the decision-point snapshots written when someone applies, receives an offer or accepts (candidate_matches without a run)
 * are kept: they are part of the hiring decision record.
 */

export const RETENTION_KEY = 'match_retention';
/** The single place the default lives; the live value is in platform_settings and changed by a super admin. */
export const DEFAULT_RETENTION_DAYS = 90;
/** Guard rails so a typo cannot wipe everything recently produced, or turn retention into "forever". */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
export const retentionSchema = z.object({ days: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS) }).strict();

export const CLEANUP_LEASE = 'match_retention';
const CLEANUP_LEASE_MS = 15 * 60_000;
const BATCH_SIZE = 500;
const MAX_BATCHES = 200;           // bounds one execution; anything left is picked up by the next one
const DAY_MS = 86_400_000;

export async function loadRetention(q: Queryable): Promise<{ days: number; version: number }> {
  const [row] = await q.query<{ value: unknown; version: number }>('SELECT value, version FROM platform_settings WHERE key = $1', [RETENTION_KEY]);
  const parsed = row ? retentionSchema.safeParse(row.value) : null;
  return parsed?.success ? { days: parsed.data.days, version: row!.version } : { days: DEFAULT_RETENTION_DAYS, version: 0 };
}

export async function saveRetention(q: Queryable, days: number, userId: string): Promise<number> {
  const [row] = await q.query<{ version: number }>(
    `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = platform_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING version`, [RETENTION_KEY, JSON.stringify({ days }), userId]);
  return row!.version;
}

const NOT_HELD = 'NOT EXISTS (SELECT 1 FROM match_run_holds h WHERE h.run_id = r.id)';
const count = async (q: Queryable, sql: string, args: unknown[]) => Number((await q.query<{ n: string }>(sql, args))[0]?.n ?? 0);

export interface CleanupSummary {
  retentionDays: number; cutoff: string;
  /** Expired and not held: what a run would delete. */
  runsExpired: number; resultsExpired: number;
  /** Expired but kept because of a legal hold. */
  runsHeld: number;
  runsDeleted: number; resultsDeleted: number; batches: number; moreRemaining: boolean;
}

async function previewCounts(q: Queryable, cutoff: Date) {
  return {
    runsExpired: await count(q, `SELECT count(*) AS n FROM match_runs r WHERE r.created_at < $1 AND ${NOT_HELD}`, [cutoff]),
    resultsExpired: await count(q, `SELECT count(*) AS n FROM candidate_matches m JOIN match_runs r ON r.id = m.run_id WHERE r.created_at < $1 AND ${NOT_HELD}`, [cutoff]),
    runsHeld: await count(q, `SELECT count(*) AS n FROM match_runs r JOIN match_run_holds h ON h.run_id = r.id WHERE r.created_at < $1`, [cutoff]),
  };
}

/** What a cleanup would delete right now. Reads only; the one write is the audit entry, as for every admin view. */
export async function previewMatchRetention(db: Db, input: { userId: string; requestId: string; now?: Date }): Promise<CleanupSummary> {
  const now = input.now ?? new Date();
  const { days } = await loadRetention(db);
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const c = await previewCounts(db, cutoff);
  await audit(db, { actorUserId: input.userId, action: 'admin.match_retention_previewed', requestId: input.requestId, metadata: { retentionDays: days, ...c } });
  return { retentionDays: days, cutoff: cutoff.toISOString(), ...c, runsDeleted: 0, resultsDeleted: 0, batches: 0, moreRemaining: c.runsExpired > 0 };
}

/**
 * Deletes expired, un-held match runs and their results in small transactions: results first, then the runs. Safe to repeat
 * (a second pass finds nothing), and only one server runs it at a time (database lease). A run is locked before it is deleted,
 * so a hold placed at the same moment either wins (the run is skipped) or waits and then finds the run gone.
 * Returns null when another execution already holds the lease.
 */
export async function runMatchRetention(db: Db, input: { mode: 'scheduled' | 'manual'; userId?: string; requestId?: string; now?: Date; batchSize?: number; maxBatches?: number }) {
  const now = input.now ?? new Date();
  const batchSize = input.batchSize ?? BATCH_SIZE, maxBatches = input.maxBatches ?? MAX_BATCHES;
  const res = await withLease(db, CLEANUP_LEASE, CLEANUP_LEASE_MS, async () => {
    const { days } = await loadRetention(db);
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const [hist] = await db.query<{ id: string }>(
      `INSERT INTO retention_runs (kind, mode, requested_by, retention_days) VALUES ('match_retention', $1, $2, $3) RETURNING id`, [input.mode, input.userId ?? null, days]);
    const sum: CleanupSummary = { retentionDays: days, cutoff: cutoff.toISOString(), runsExpired: 0, resultsExpired: 0, runsHeld: 0, runsDeleted: 0, resultsDeleted: 0, batches: 0, moreRemaining: false };
    try {
      for (let i = 0; i < maxBatches; i++) {
        const ids = (await db.query<{ id: string }>(
          `SELECT r.id FROM match_runs r WHERE r.created_at < $1 AND ${NOT_HELD} ORDER BY r.created_at, r.id LIMIT $2`, [cutoff, batchSize])).map((r) => r.id);
        if (!ids.length) break;
        const done = await db.transaction(async (tx) => {
          // Lock first, check holds second. Placing a hold needs a key-share lock on the run, which waits for ours; checking in a
          // separate statement afterwards gives a fresh snapshot, so a hold that committed while we waited is seen and skipped.
          await tx.query('SELECT r.id FROM match_runs r WHERE r.id = ANY($1::uuid[]) ORDER BY r.id FOR UPDATE', [ids]);
          const locked = (await tx.query<{ id: string }>(
            `SELECT r.id FROM match_runs r WHERE r.id = ANY($1::uuid[]) AND ${NOT_HELD} ORDER BY r.id`, [ids])).map((r) => r.id);
          if (!locked.length) return { runs: 0, results: 0 };
          const results = await count(tx, 'WITH d AS (DELETE FROM candidate_matches WHERE run_id = ANY($1::uuid[]) RETURNING 1) SELECT count(*) AS n FROM d', [locked]);
          const runs = await count(tx, 'WITH d AS (DELETE FROM match_runs WHERE id = ANY($1::uuid[]) RETURNING 1) SELECT count(*) AS n FROM d', [locked]);
          return { runs, results };
        });
        // A batch can come back empty if every run in it was held in the meantime; the next selection skips those, so keep going.
        sum.batches++; sum.runsDeleted += done.runs; sum.resultsDeleted += done.results;
      }
      const left = await previewCounts(db, cutoff);
      sum.runsHeld = left.runsHeld; sum.runsExpired = left.runsExpired; sum.resultsExpired = left.resultsExpired;
      sum.moreRemaining = left.runsExpired > 0;
      const counts = { runsDeleted: sum.runsDeleted, resultsDeleted: sum.resultsDeleted, runsHeld: sum.runsHeld, batches: sum.batches, moreRemaining: sum.moreRemaining };
      await db.query(`UPDATE retention_runs SET status = 'completed', counts = $2::jsonb, finished_at = now() WHERE id = $1`, [hist!.id, JSON.stringify(counts)]);
      await audit(db, { actorUserId: input.userId ?? null, action: 'match.retention_cleanup', targetType: 'retention_run', targetId: hist!.id, requestId: input.requestId, metadata: { mode: input.mode, retentionDays: days, ...counts } });
      return sum;
    } catch (e) {
      // The error class only: messages can carry values.
      await db.query(`UPDATE retention_runs SET status = 'failed', error_code = $2, counts = $3::jsonb, finished_at = now() WHERE id = $1`,
        [hist!.id, e instanceof Error ? e.name : 'Error', JSON.stringify({ runsDeleted: sum.runsDeleted, resultsDeleted: sum.resultsDeleted, batches: sum.batches })]).catch(() => undefined);
      throw e;
    }
  }, undefined, now);
  return res.ran ? res.value : null;
}

/** Runs cleanup on a timer inside the API process (like shift recovery): the lease keeps several servers from overlapping. */
export function startMatchRetentionScheduler(deps: { db: Db }, intervalMs: number, initialDelayMs = 60_000): () => void {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const sum = await runMatchRetention(deps.db, { mode: 'scheduled' });
      if (sum && (sum.runsDeleted || sum.moreRemaining)) logger.info({ runsDeleted: sum.runsDeleted, resultsDeleted: sum.resultsDeleted, moreRemaining: sum.moreRemaining }, 'match retention pass');
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.name : 'unknown' }, 'match retention pass failed');
    } finally { running = false; }
  };
  const first = setTimeout(pass, initialDelayMs);
  const timer = setInterval(pass, intervalMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---- legal holds

export async function placeHolds(db: Db, input: { runIds: string[]; reason: string; userId: string; requestId: string }) {
  const rows = await db.query<{ run_id: string }>(
    `INSERT INTO match_run_holds (run_id, reason, placed_by) SELECT id, $2, $3 FROM match_runs WHERE id = ANY($1::uuid[])
     ON CONFLICT (run_id) DO NOTHING RETURNING run_id`, [input.runIds, input.reason, input.userId]);
  const existing = await count(db, 'SELECT count(*) AS n FROM match_run_holds WHERE run_id = ANY($1::uuid[])', [input.runIds]);
  const out = { requested: input.runIds.length, newlyHeld: rows.length, nowHeld: existing, notFound: input.runIds.length - existing };
  await audit(db, { actorUserId: input.userId, action: 'admin.match_hold_placed', requestId: input.requestId, metadata: { reference: input.reason, ...out } });
  return out;
}

export async function releaseHold(db: Db, input: { runId: string; userId: string; requestId: string }) {
  const rows = await db.query('DELETE FROM match_run_holds WHERE run_id = $1 RETURNING run_id', [input.runId]);
  if (rows.length) await audit(db, { actorUserId: input.userId, action: 'admin.match_hold_released', targetType: 'match_run', targetId: input.runId, requestId: input.requestId });
  return rows.length > 0;
}

export async function listHolds(db: Db) {
  return db.query(
    `SELECT h.run_id, h.reason, h.placed_at, r.job_id, r.organization_id, r.created_at AS run_created_at
       FROM match_run_holds h JOIN match_runs r ON r.id = h.run_id ORDER BY h.placed_at DESC, h.run_id LIMIT 200`);
}

export async function listRetentionHistory(db: Db, kind?: string) {
  return db.query(
    `SELECT id, kind, mode, status, retention_days, counts, error_code, started_at, finished_at FROM retention_runs
      WHERE ($1::text IS NULL OR kind = $1) ORDER BY started_at DESC, id LIMIT 50`, [kind ?? null]);
}

// ---- professional erasure (matching data only)

export interface ErasureSummary {
  dryRun: boolean;
  resultsDeleted: number;
  /** Results kept because their run is under a legal hold. */
  resultsHeld: number;
  talentRefsDeleted: number;
  /** Kept while any of their results is held: the reference is needed to interpret held evidence. */
  talentRefsKept: number;
  /** Apply/offer/accept snapshots, kept as part of the hiring decision record. */
  decisionSnapshotsKept: number;
  /** True if the person can still appear in future match runs; erasing past data does not stop that. */
  stillDiscoverable: boolean | null;
}

async function erasureCounts(q: Queryable, professionalId: string) {
  return {
    resultsAll: await count(q, 'SELECT count(*) AS n FROM candidate_matches WHERE professional_id = $1 AND run_id IS NOT NULL', [professionalId]),
    resultsHeld: await count(q, `SELECT count(*) AS n FROM candidate_matches m JOIN match_run_holds h ON h.run_id = m.run_id WHERE m.professional_id = $1`, [professionalId]),
    talentRefs: await count(q, 'SELECT count(*) AS n FROM talent_refs WHERE professional_id = $1', [professionalId]),
    decisionSnapshotsKept: await count(q, 'SELECT count(*) AS n FROM candidate_matches WHERE professional_id = $1 AND run_id IS NULL', [professionalId]),
    stillDiscoverable: (await q.query<{ d: boolean }>('SELECT discoverable AS d FROM professionals WHERE id = $1', [professionalId]))[0]?.d ?? null,
  };
}

/**
 * Removes one professional's match results and anonymous talent references. This is NOT account erasure: the account, profile,
 * credentials, applications, offers, assignments, timesheets, reviews and the audit log are untouched and need their own
 * process. Idempotent (a repeat finds nothing), and it works for a professional whose account no longer exists, because
 * match results are linked by value and not by a foreign key. Other people's results are never touched.
 */
export async function eraseProfessionalMatchData(db: Db, input: { professionalId: string; dryRun: boolean; reference?: string; userId: string; requestId: string }): Promise<ErasureSummary> {
  const id = input.professionalId;
  if (input.dryRun) {
    const c = await erasureCounts(db, id);
    const out: ErasureSummary = {
      dryRun: true, resultsDeleted: c.resultsAll - c.resultsHeld, resultsHeld: c.resultsHeld,
      talentRefsDeleted: c.resultsHeld > 0 ? 0 : c.talentRefs, talentRefsKept: c.resultsHeld > 0 ? c.talentRefs : 0,
      decisionSnapshotsKept: c.decisionSnapshotsKept, stillDiscoverable: c.stillDiscoverable,
    };
    await audit(db, { actorUserId: input.userId, action: 'admin.match_erasure_previewed', targetType: 'professional', targetId: id, requestId: input.requestId, metadata: { reference: input.reference, ...out } });
    return out;
  }
  try {
    return await db.transaction(async (tx) => {
      // Lock the affected runs first so a hold placed at the same moment cannot be bypassed (and cleanup cannot race us).
      await tx.query(
        `SELECT r.id FROM match_runs r WHERE r.id IN (SELECT run_id FROM candidate_matches WHERE professional_id = $1 AND run_id IS NOT NULL) ORDER BY r.id FOR UPDATE`, [id]);
      const resultsDeleted = await count(tx,
        `WITH d AS (DELETE FROM candidate_matches m WHERE m.professional_id = $1 AND m.run_id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM match_run_holds h WHERE h.run_id = m.run_id) RETURNING 1) SELECT count(*) AS n FROM d`, [id]);
      const c = await erasureCounts(tx, id);
      const keepRefs = c.resultsHeld > 0;
      const talentRefsDeleted = keepRefs ? 0 : await count(tx, 'WITH d AS (DELETE FROM talent_refs WHERE professional_id = $1 RETURNING 1) SELECT count(*) AS n FROM d', [id]);
      const out: ErasureSummary = {
        dryRun: false, resultsDeleted, resultsHeld: c.resultsHeld, talentRefsDeleted, talentRefsKept: keepRefs ? c.talentRefs : 0,
        decisionSnapshotsKept: c.decisionSnapshotsKept, stillDiscoverable: c.stillDiscoverable,
      };
      const { dryRun: _d, stillDiscoverable: _s, ...counts } = out;
      // History holds counts only. The audit entry names the opaque professional id so the action stays accountable.
      await tx.query(`INSERT INTO retention_runs (kind, mode, status, requested_by, counts, finished_at) VALUES ('professional_erasure','manual','completed',$1,$2::jsonb, now())`, [input.userId, JSON.stringify(counts)]);
      await audit(tx, { actorUserId: input.userId, action: 'admin.match_data_erased', targetType: 'professional', targetId: id, requestId: input.requestId, metadata: { reference: input.reference, ...counts } });
      return out;
    });
  } catch (e) {
    await db.query(`INSERT INTO retention_runs (kind, mode, status, requested_by, error_code, finished_at) VALUES ('professional_erasure','manual','failed',$1,$2, now())`,
      [input.userId, e instanceof Error ? e.name : 'Error']).catch(() => undefined);
    throw e;
  }
}
