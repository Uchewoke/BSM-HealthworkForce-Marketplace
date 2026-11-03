import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgDb, migrate, type Db } from '../src/db/index.js';
import { eraseProfessionalMatchData, placeHolds, runMatchRetention } from '../src/modules/matching/retention.js';

/**
 * Concurrency tests that need a real PostgreSQL server with several connections (the embedded test database has one).
 * Skipped unless TEST_DATABASE_URL points at a server where this user may create databases, for example
 *   TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npx vitest run tests/match-retention.pg.test.ts
 * Each file gets its own new database. Interleavings are forced with explicit transactions on separate connections, so the
 * outcomes are deterministic and not left to timing luck.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const ORG = randomUUID(), JOB = randomUUID();

describe.skipIf(!ADMIN_URL)('match retention on real PostgreSQL: legal hold concurrency', () => {
  let url: string, db: Db, userId: string;
  const clients: pg.Client[] = [];

  const connect = async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); clients.push(c); return c; };
  const n = async (sql: string, args: unknown[] = []) => Number((await db.query<{ n: string }>(sql, args))[0]!.n);

  /** Seeds expired runs with results. Foreign keys are bypassed for the seed only (these tables reference rows we do not need). */
  async function seedRuns(count: number, resultsEach: number, daysOld = 200): Promise<[string, string, ...string[]]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL session_replication_role = replica');
      await tx.query(
        `INSERT INTO match_runs (id, organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count, created_at)
         SELECT i, $2, $3, 'talent', $4, 'eligibility-v1', 'ranking-v1', 0, $5, now() - ($6 || ' days')::interval FROM unnest($1::uuid[]) i`, [ids, ORG, JOB, userId, resultsEach, String(daysOld)]);
      await tx.query(
        `INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, outcome, eligibility, rules_version, weights_version)
         SELECT r, $2, $3, gen_random_uuid(), 'recommend', 'talent', 'needs_review', '{}'::jsonb, 'eligibility-v1', 0 FROM unnest($1::uuid[]) r, generate_series(1, $4::int)`, [ids, ORG, JOB, resultsEach]);
    });
    return ids as [string, string, ...string[]];
  }
  const exists = async (id: string) => (await n('SELECT count(*) AS n FROM match_runs WHERE id = $1', [id])) === 1;
  const results = (id: string) => n('SELECT count(*) AS n FROM candidate_matches WHERE run_id = $1', [id]);
  const holdExists = async (id: string) => (await n('SELECT count(*) AS n FROM match_run_holds WHERE run_id = $1', [id])) === 1;
  const reset = async () => {
    await db.query('DELETE FROM match_run_holds');
    await db.transaction(async (tx) => { await tx.query('DELETE FROM candidate_matches WHERE run_id IS NOT NULL'); await tx.query('DELETE FROM match_runs'); });
    await db.query('DELETE FROM scheduler_leases');
  };

  /** Waits until some backend in this database is blocked on a lock: proof that the two operations really overlapped. */
  async function waitUntilBlocked(probe: pg.Client, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = await probe.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (r.rows[0].n > 0) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('expected an operation to be blocked on a lock, but none was');
  }
  const pending = <T,>(p: Promise<T>) => { const s = { done: false }; void p.then(() => { s.done = true; }, () => { s.done = true; }); return s; };

  beforeAll(async () => {
    const name = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
    const u = new URL(ADMIN_URL!); u.pathname = `/${name}`; url = u.toString();
    db = createPgDb(url);
    await migrate(db);
    userId = (await db.query<{ id: string }>(`INSERT INTO users (email, password_hash, full_name) VALUES ('hold.admin@example.com','x','Hold Admin') RETURNING id`))[0]!.id;
  }, 60_000);
  afterAll(async () => { for (const c of clients) await c.end().catch(() => undefined); await db?.close(); });

  it('refuses, at the database level, to delete a held run or any of its results, whoever asks', async () => {
    await reset();
    const [held, free] = await seedRuns(2, 3);
    await db.query('INSERT INTO match_run_holds (run_id, reason, placed_by) VALUES ($1, $2, $3)', [held, 'Matter 1', userId]);
    await expect(db.query('DELETE FROM match_runs WHERE id = $1', [held])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('DELETE FROM candidate_matches WHERE run_id = $1', [held])).rejects.toThrow(/held match run/);
    await expect(db.query(`DELETE FROM candidate_matches WHERE run_id = $1 AND professional_id IN (SELECT professional_id FROM candidate_matches WHERE run_id = $1 LIMIT 1)`, [held])).rejects.toThrow(/held match run/);
    // One statement touching a held and an un-held run is refused as a whole.
    await expect(db.query('DELETE FROM candidate_matches WHERE run_id = ANY($1::uuid[])', [[held, free]])).rejects.toThrow(/held match run/);
    expect([await results(held), await results(free), await exists(held)]).toEqual([3, 3, true]);
    // Un-held results and decision snapshots (no run) remain deletable, so ordinary erasure and cascades are not blocked.
    await db.query('DELETE FROM candidate_matches WHERE run_id = $1', [free]);
    expect(await results(free)).toBe(0);
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL session_replication_role = replica');
      await tx.query(`INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, rules_version, weights_version)
                      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'apply', 'eligible', '{}'::jsonb, 'v', 0)`, [ORG, JOB]);
    });
    await db.query('DELETE FROM candidate_matches WHERE run_id IS NULL');
    // Releasing the hold lifts the protection.
    await db.query('DELETE FROM match_run_holds WHERE run_id = $1', [held]);
    await db.query('DELETE FROM candidate_matches WHERE run_id = $1', [held]);
    expect(await results(held)).toBe(0);
  });

  it('makes a hold wait while cleanup has the run locked, then fails it cleanly: never a held run that lost data', async () => {
    await reset();
    const [x] = await seedRuns(1, 4);
    const cleanup = await connect(), hold = await connect(), probe = await connect();
    await cleanup.query('BEGIN');
    await cleanup.query('SELECT id FROM match_runs WHERE id = $1 FOR UPDATE', [x]);        // what a cleanup batch does first
    const attempt = hold.query('INSERT INTO match_run_holds (run_id, reason, placed_by) VALUES ($1, $2, $3)', [x, 'Matter 2', userId]);
    const state = pending(attempt.catch(() => undefined));
    await waitUntilBlocked(probe);
    expect(state.done).toBe(false);                                                        // the hold really is waiting
    await cleanup.query('DELETE FROM candidate_matches WHERE run_id = $1', [x]);
    await cleanup.query('DELETE FROM match_runs WHERE id = $1', [x]);
    await cleanup.query('COMMIT');
    await expect(attempt).rejects.toMatchObject({ code: '23503' });                       // the run is gone, so the hold is refused
    expect(await holdExists(x)).toBe(false);
    expect([await exists(x), await results(x)]).toEqual([false, 0]);
  });

  it('skips a run when a hold commits while the real cleanup is waiting for its lock', async () => {
    await reset();
    const [x, y] = await seedRuns(2, 4);
    const hold = await connect(), probe = await connect();
    await hold.query('BEGIN');
    await hold.query('INSERT INTO match_run_holds (run_id, reason, placed_by) VALUES ($1, $2, $3)', [x, 'Matter 3', userId]);   // uncommitted
    const cleanup = runMatchRetention(db, { mode: 'manual', userId });                                                         // the real function
    const state = pending(cleanup);
    await waitUntilBlocked(probe);
    expect(state.done).toBe(false);                                                        // cleanup waits for the hold's transaction
    await hold.query('COMMIT');
    const summary = await cleanup;
    expect(summary).not.toBeNull();
    expect(summary!.runsDeleted).toBe(1);                                                  // y only
    expect([await exists(x), await results(x), await holdExists(x)]).toEqual([true, 4, true]);
    expect([await exists(y), await results(y)]).toEqual([false, 0]);
    expect((await db.query<any>(`SELECT status FROM retention_runs ORDER BY started_at DESC LIMIT 1`))[0].status).toBe('completed');
  });

  it('keeps held results when erasure races a hold, and keeps the references that explain them', async () => {
    await reset();
    await db.query('DELETE FROM talent_refs');
    const professional = randomUUID();
    const runs = [randomUUID(), randomUUID()];
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL session_replication_role = replica');
      await tx.query(`INSERT INTO match_runs (id, organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count, created_at)
                      SELECT i, $2, $3, 'talent', $4, 'eligibility-v1', 'ranking-v1', 0, 1, now() FROM unnest($1::uuid[]) i`, [runs, ORG, JOB, userId]);
      await tx.query(`INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, outcome, eligibility, rules_version, weights_version)
                      SELECT r, $2, $3, $4, 'recommend', 'talent', 'needs_review', '{}'::jsonb, 'eligibility-v1', 0 FROM unnest($1::uuid[]) r`, [runs, ORG, JOB, professional]);
      await tx.query(`INSERT INTO talent_refs (organization_id, professional_id, ref) VALUES ($1, $2, $3)`, [ORG, professional, `ref-${randomUUID()}`]);
    });
    const hold = await connect(), probe = await connect();
    await hold.query('BEGIN');
    await hold.query('INSERT INTO match_run_holds (run_id, reason, placed_by) VALUES ($1, $2, $3)', [runs[0], 'Matter 4', userId]);
    const erasure = eraseProfessionalMatchData(db, { professionalId: professional, dryRun: false, userId, requestId: 'test' });
    const state = pending(erasure);
    await waitUntilBlocked(probe);
    expect(state.done).toBe(false);
    await hold.query('COMMIT');
    const summary = await erasure;
    expect(summary).toMatchObject({ resultsDeleted: 1, resultsHeld: 1, talentRefsDeleted: 0, talentRefsKept: 1 });
    expect([await results(runs[0]!), await results(runs[1]!)]).toEqual([1, 0]);
    expect(await n('SELECT count(*) AS n FROM talent_refs WHERE professional_id = $1', [professional])).toBe(1);
  });

  it('never ends with a held run missing data, however hold and cleanup interleave (randomized)', async () => {
    await reset();
    const tally = { heldIntact: 0, deleted: 0, holdRefused: 0 };
    for (let i = 0; i < 40; i++) {
      const [id] = await seedRuns(1, 5);
      const delay = (max: number) => new Promise((r) => setTimeout(r, Math.floor(Math.random() * max)));   // a hold is one insert and cleanup is several queries, so the hold gets the wider spread to hit both orders
      const doCleanup = async () => { await delay(10); await runMatchRetention(db, { mode: 'manual', userId }); };
      const doHold = async () => {
        await delay(40);
        try { await placeHolds(db, { runIds: [id!], reason: 'Matter stress', userId, requestId: 'test' }); }
        catch (e: any) { if (e?.code !== '23503') throw e; tally.holdRefused++; }
      };
      await Promise.all(Math.random() < 0.5 ? [doCleanup(), doHold()] : [doHold(), doCleanup()]);
      const held = await holdExists(id!);
      if (held) {
        // The invariant: a held run is still there with every result.
        expect([await exists(id!), await results(id!)], `iteration ${i}`).toEqual([true, 5]);
        tally.heldIntact++;
        await db.query('DELETE FROM match_run_holds WHERE run_id = $1', [id]);
      } else {
        // Not held: cleanup always processes an expired run, so it must be gone with its results.
        expect([await exists(id!), await results(id!)], `iteration ${i}`).toEqual([false, 0]);
        tally.deleted++;
      }
      await reset();
    }
    console.log('random interleavings:', JSON.stringify(tally));
    expect(tally.heldIntact + tally.deleted).toBe(40);
  }, 120_000);

  it('applies migration 0017 under live write traffic without deadlocking or failing any writer (repeated)', async () => {
    const migrationsDir = new URL('../migrations/', import.meta.url);
    const adminSql = async (sql: string) => { const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); try { await a.query(sql); } finally { await a.end(); } };
    const urlOf = (name: string) => { const u = new URL(ADMIN_URL!); u.pathname = `/${name}`; return u.toString(); };

    // Expensive setup once: a template database at schema 0016 holding enough rows that the index build takes a noticeable moment.
    // Each round then clones it, which is fast, instead of re-applying 16 migrations and re-seeding.
    const template = `t_tpl_${randomBytes(6).toString('hex')}`;
    await adminSql(`CREATE DATABASE ${template}`);
    const staged = mkdtempSync(join(tmpdir(), 'bsm-mig-'));
    for (const f of readdirSync(migrationsDir).filter((x) => /^\d{4}_.+\.sql$/.test(x) && x.slice(0, 4) <= '0016')) copyFileSync(new URL(f, migrationsDir), join(staged, f));
    const tpl = createPgDb(urlOf(template));
    await migrate(tpl, pathToFileURL(staged + '/'));
    const uid = (await tpl.query<{ id: string }>(`INSERT INTO users (email, password_hash, full_name) VALUES ('mig@example.com','x','Mig') RETURNING id`))[0]!.id;
    await tpl.transaction(async (tx) => {
      await tx.exec('SET LOCAL session_replication_role = replica');
      // 150,000 decision snapshots (no run), as a production table would hold.
      await tx.query(`INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, rules_version, weights_version)
                      SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), 'apply', 'eligible', '{}'::jsonb, 'v', 0 FROM generate_series(1, 150000)`, [ORG, JOB]);
    });
    await tpl.close();                                                                       // a template must have no open connections

    const outcomes = { committed: 0, deadlock: 0, lockTimeout: 0, other: 0 };
    const timings: Record<string, number[]> = { cloneMs: [], migrateMs: [] };
    for (let round = 0; round < 3; round++) {
      const name = `t_${randomBytes(6).toString('hex')}`;
      const t0 = Date.now();
      await adminSql(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      timings.cloneMs!.push(Date.now() - t0);
      const d = createPgDb(urlOf(name));
      // Writers run the same transaction shape as match-run creation: the run row first, then its results.
      let stop = false;
      const writers = Array.from({ length: 3 }, async () => {
        const c = new pg.Client({ connectionString: urlOf(name) }); await c.connect();
        while (!stop) {
          try {
            await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
            const id = randomUUID();
            await c.query(`INSERT INTO match_runs (id, organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count) VALUES ($1,$2,$3,'talent',$4,'v','r',0,1)`, [id, ORG, JOB, uid]);
            await new Promise((r) => setTimeout(r, 15));                                     // widen the window between the two inserts
            await c.query(`INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, outcome, eligibility, rules_version, weights_version) VALUES ($1,$2,$3,$4,'recommend','talent','eligible','{}'::jsonb,'v',0)`, [id, ORG, JOB, randomUUID()]);
            await c.query('COMMIT'); outcomes.committed++;
          } catch (e: any) {
            await c.query('ROLLBACK').catch(() => undefined);
            if (e?.code === '40P01') outcomes.deadlock++; else if (e?.code === '55P03') outcomes.lockTimeout++; else outcomes.other++;
          }
        }
        await c.end();
      });
      await new Promise((r) => setTimeout(r, 300));
      const t1 = Date.now();
      await migrate(d, migrationsDir);                                                        // the real migration, with writers running
      timings.migrateMs!.push(Date.now() - t1);
      await new Promise((r) => setTimeout(r, 300));
      stop = true; await Promise.all(writers);
      expect((await d.query<any>(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('match_run_holds','retention_runs','match_runs_created_idx','candidate_matches_professional_run_idx')`))[0].n, `round ${round}`).toBe(4);
      await d.close();
    }
    console.log('writers during migration:', JSON.stringify(outcomes), 'timings:', JSON.stringify(timings));
    expect(outcomes).toMatchObject({ deadlock: 0, lockTimeout: 0, other: 0 });
    expect(outcomes.committed).toBeGreaterThan(0);
  }, 300_000);
});
