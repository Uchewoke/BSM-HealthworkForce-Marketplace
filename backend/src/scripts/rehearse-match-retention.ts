/**
 * Rehearses migration 0017 (match retention) against a production-like PostgreSQL database and prints evidence as JSON:
 * migration time, per-statement time, table locks taken, effect on concurrent writers and readers, data integrity, query plans,
 * rollback, failed-migration atomicity, cleanup throughput, and backup/restore/re-migrate.
 *
 * It builds its own throwaway database (named rehearsal_*) on the server in REHEARSAL_ADMIN_URL and refuses to touch anything
 * else. The data is synthetic: it has the right shape and a realistic volume, but not your real distribution. For the real
 * rehearsal, restore a production backup into a rehearsal_* database and run the same steps by hand (see
 * documentation/operations/match-retention-deployment.md).
 *
 *   REHEARSAL_ADMIN_URL=postgres://postgres@localhost:55432/postgres PG_BIN="C:/Program Files/PostgreSQL/18/bin" \
 *     npx tsx src/scripts/rehearse-match-retention.ts
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPgDb, migrate } from '../db/index.js';
import { runMatchRetention } from '../modules/matching/retention.js';

const adminUrl = process.env.REHEARSAL_ADMIN_URL;
if (!adminUrl) throw new Error('Set REHEARSAL_ADMIN_URL to a server where this user may create databases.');
const PG_BIN = process.env.PG_BIN ?? '';
const PROFESSIONALS = Number(process.env.REHEARSAL_PROFESSIONALS ?? 20_000);   // each has one application and SNAP_PER_APP decision snapshots
const SNAP_PER_APP = 15;
const SNAPSHOTS = PROFESSIONALS * SNAP_PER_APP;
const RUNS = Number(process.env.REHEARSAL_RUNS ?? 40_000);
const PER_RUN = Number(process.env.REHEARSAL_RESULTS_PER_RUN ?? 12);
const AUDIT = Number(process.env.REHEARSAL_AUDIT ?? 400_000);

const ORG = randomUUID(), JOB = randomUUID();
const migrationsDir = new URL('../../migrations/', import.meta.url);
const report: Record<string, unknown> = { volumes: { snapshots: SNAPSHOTS, runs: RUNS, resultsPerRun: PER_RUN, auditRows: AUDIT } };
const log = (m: string) => console.error(`[rehearsal] ${m}`);
const timed = async <T,>(f: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const v = await f(); return [v, Math.round(performance.now() - t)]; };
const bin = (name: string) => (PG_BIN ? join(PG_BIN, name) : name);

const dbName = `rehearsal_${Date.now()}`;
const urlFor = (name: string) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u; };
const dumpArgs = (name: string) => { const u = urlFor(name); return ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username || 'postgres'), '-d', name]; };

function stage(upTo: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'bsm-mig-'));
  for (const f of readdirSync(migrationsDir).filter((x) => /^\d{4}_.+\.sql$/.test(x) && x.slice(0, 4) <= upTo)) copyFileSync(new URL(f, migrationsDir), join(dir, f));
  return pathToFileURL(dir + '/');
}

/** Splits a migration into statements, keeping $$-quoted function bodies intact. */
function splitSql(sql: string): string[] {
  const out: string[] = []; let cur = ''; let inDollar = false;
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, '');
    if (!line.trim() && !cur.trim()) continue;
    cur += line + '\n';
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inDollar = !inDollar;
    if (!inDollar && line.trim().endsWith(';')) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const schemaDump = (name: string) => execFileSync(bin('pg_dump.exe'), ['--schema-only', '--no-owner', '--no-privileges', ...dumpArgs(name)], { maxBuffer: 1 << 28 }).toString()
  .split('\n').filter((l) => l.trim() && !l.startsWith('--') && !l.startsWith('\\restrict') && !l.startsWith('\\unrestrict')).join('\n');

async function main() {
  if (!dbName.startsWith('rehearsal_')) throw new Error('refusing to run');
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = urlFor(dbName).toString();
  const db = createPgDb(url);
  const q = (sql: string, args: unknown[] = []) => db.query<any>(sql, args);
  const checksum = async () => {
    const out: Record<string, string> = {};
    for (const [t, where] of [['candidate_matches', `rules_version <> 'writer'`], ['match_runs', `scope <> 'both'`], ['audit_logs', 'true']] as const) {
      const r = (await q(`SELECT count(*) AS n, md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM ${t} WHERE ${where}`))[0];
      out[t] = `${r.n}:${r.h}`;
    }
    return out;
  };

  // 1. Schema through 0015, legacy data
  log('migrating to 0015'); await migrate(db, stage('0015'));
  const userId = (await q(`INSERT INTO users (email, password_hash, full_name) VALUES ('rehearsal@example.com','x','Rehearsal') RETURNING id`))[0].id as string;
  const [, seedLegacyMs] = await timed(async () => {
    await q(`INSERT INTO organizations (id, name, type, status, created_by) VALUES ($1, 'Rehearsal Health', 'facility', 'approved', $2)`, [ORG, userId]);
    const fac = (await q(`INSERT INTO facilities (organization_id, name, facility_type) VALUES ($1, 'Rehearsal Hospital', 'hospital') RETURNING id`, [ORG]))[0].id as string;
    const loc = (await q(`INSERT INTO facility_locations (organization_id, facility_id, name, address_line1, city, state, postal_code, timezone) VALUES ($1,$2,'Main','1 Main St','Atlanta','GA','30303','America/New_York') RETURNING id`, [ORG, fac]))[0].id as string;
    const prof = (await q(`SELECT id FROM professions WHERE code = 'rn'`))[0].id as string;
    await q(`INSERT INTO jobs (id, organization_id, location_id, title, profession_id, employment_type, status, created_by) VALUES ($1,$2,$3,'ICU Nurse',$4,'permanent','published',$5)`, [JOB, ORG, loc, prof, userId]);
    await q(`INSERT INTO users (email, password_hash, full_name) SELECT 'pro' || g || '@example.com', 'x', 'Pro ' || g FROM generate_series(1, $1) g`, [PROFESSIONALS]);
    await q(`INSERT INTO professionals (user_id, profession_id) SELECT u.id, $1 FROM users u WHERE u.email LIKE 'pro%@example.com'`, [prof]);
    await q(`INSERT INTO applications (job_id, organization_id, professional_id) SELECT $1, $2, p.id FROM professionals p`, [JOB, ORG]);
    await q(
      `INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, score, explanation, rules_version, weights_version)
       SELECT a.id, a.organization_id, a.job_id, a.professional_id, (ARRAY['apply','offer','accept'])[1 + k % 3], 'eligible',
              jsonb_build_object('reasons','[]'::jsonb,'padding',repeat('x',300)), 80, '{}'::jsonb, 'eligibility-v1', 0 FROM applications a, generate_series(1, $1) k`, [SNAP_PER_APP]);
    await q(`INSERT INTO audit_logs (action, metadata) SELECT 'seed.event', jsonb_build_object('n', g) FROM generate_series(1, $1) g`, [AUDIT]);
  });
  report.seedLegacyMs = seedLegacyMs;

  // 2. 0016 over the legacy data (this one touched an existing table, so it is worth timing too)
  const [, m16] = await timed(() => migrate(db, stage('0016')));
  report.migration0016Ms = m16;
  report.triggerCheckConstraint = (await q(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'candidate_matches'::regclass AND contype = 'c' ORDER BY 1`)).map((r) => `${r.conname}${r.convalidated ? '' : ' (NOT VALIDATED)'}`);
  log('seeding match runs');
  const [, seedRunsMs] = await timed(() => db.query(
    `WITH r AS (
       INSERT INTO match_runs (id, organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count, created_at)
       SELECT gen_random_uuid(), $3, $4, 'talent', $5, 'eligibility-v1', 'ranking-v1', 0, $2, now() - ((1 + g % 300) || ' days')::interval FROM generate_series(1, $1) g RETURNING id, created_at)
     INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, rank, outcome, eligibility, score, explanation, rules_version, weights_version, evaluated_at)
     SELECT r.id, $3, $4, gen_random_uuid(), 'recommend', 'talent', k, 'eligible', jsonb_build_object('reasons','[]'::jsonb,'padding',repeat('x',300)), 80, '{}'::jsonb, 'eligibility-v1', 0, r.created_at
       FROM r, generate_series(1, $2) k`, [RUNS, PER_RUN, ORG, JOB, userId]));
  report.seedRunsMs = seedRunsMs;
  await q('ANALYZE');
  const before = await checksum();
  const schemaBefore = schemaDump(dbName);
  const dumpFile = join(mkdtempSync(join(tmpdir(), 'bsm-dump-')), 'pre0017.dump');
  const [, dumpMs] = await timed(async () => { execFileSync(bin('pg_dump.exe'), ['-Fc', '-f', dumpFile, ...dumpArgs(dbName)], { maxBuffer: 1 << 28 }); });
  report.preMigration = { checksums: before, tables: (await q(`SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname IN ('match_runs','candidate_matches','audit_logs') ORDER BY 1`)), backupMs: dumpMs };

  // 3. 0017 under concurrent traffic, statement by statement, with lock sampling
  const sqlText = readFileSync(new URL('0017_match_retention.sql', migrationsDir), 'utf8');
  const statements = splitSql(sqlText);
  const migrator = new pg.Client({ connectionString: url, application_name: 'rehearsal-migrator' }); await migrator.connect();
  const writer = new pg.Client({ connectionString: url }); await writer.connect();
  const reader = new pg.Client({ connectionString: url }); await reader.connect();
  const sampler = new pg.Client({ connectionString: url }); await sampler.connect();
  let stop = false;
  const writes: { at: number; ms: number }[] = [], reads: { at: number; ms: number }[] = [];
  const t0 = performance.now();
  const writerLoop = (async () => {
    while (!stop) {
      const s = performance.now();
      await writer.query('BEGIN');
      const id = randomUUID();
      await writer.query(`INSERT INTO match_runs (id, organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count) VALUES ($1,$2,$3,'both',$4,'writer','ranking-v1',0,1)`, [id, ORG, JOB, userId]);
      await writer.query(`INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, outcome, eligibility, rules_version, weights_version) VALUES ($1,$2,$3,$4,'recommend','talent','eligible','{}'::jsonb,'writer',0)`, [id, ORG, JOB, randomUUID()]);
      await writer.query('COMMIT');
      writes.push({ at: s - t0, ms: performance.now() - s });
      await new Promise((r) => setTimeout(r, 4));
    }
  })();
  const readerLoop = (async () => {
    while (!stop) { const s = performance.now(); await reader.query(`SELECT count(*) FROM match_runs WHERE created_at > now() - interval '1 day'`); reads.push({ at: s - t0, ms: performance.now() - s }); await new Promise((r) => setTimeout(r, 4)); }
  })();
  const locks = new Set<string>();
  const samplerLoop = (async () => {
    while (!stop) {
      const r = await sampler.query(
        `SELECT c.relname, l.mode, l.granted FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid JOIN pg_class c ON c.oid = l.relation
          WHERE a.application_name = 'rehearsal-migrator' AND l.locktype = 'relation' AND c.relname !~ '^(pg_|schema_migrations)' AND l.mode <> 'AccessShareLock'`);
      for (const row of r.rows) locks.add(`${row.mode} on ${row.relname}${row.granted ? '' : ' (waiting)'}`);
      await new Promise((res) => setTimeout(res, 10));
    }
  })();
  await new Promise((r) => setTimeout(r, 400));                       // baseline traffic
  const perStatement: { statement: string; ms: number }[] = [];
  const migStart = performance.now() - t0;
  await migrator.query('BEGIN');
  for (const st of statements) {
    const s = performance.now(); await migrator.query(st);
    perStatement.push({ statement: st.replace(/\s+/g, ' ').slice(0, 70), ms: Math.round(performance.now() - s) });
  }
  await migrator.query(`INSERT INTO schema_migrations (name) VALUES ('0017_match_retention.sql')`);
  await migrator.query('COMMIT');
  const migEnd = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 400));                       // recovery traffic
  stop = true; await Promise.all([writerLoop, readerLoop, samplerLoop]);
  const within = (xs: { at: number; ms: number }[], a: number, b: number) => xs.filter((x) => x.at >= a && x.at <= b + 1).map((x) => x.ms);
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]!) : null; };
  report.migration0017 = {
    totalMs: Math.round(migEnd - migStart), perStatement,
    locksTaken: [...locks].sort(),
    writerLatencyMs: { baselineP50: pct(within(writes, 0, migStart), 0.5), baselineMax: pct(within(writes, 0, migStart), 1), duringMigrationMax: pct(within(writes, migStart, migEnd), 1), writesDuring: within(writes, migStart, migEnd).length, afterMax: pct(within(writes, migEnd, Infinity), 1) },
    readerLatencyMs: { baselineP50: pct(within(reads, 0, migStart), 0.5), duringMigrationMax: pct(within(reads, migStart, migEnd), 1) },
  };
  for (const c of [migrator, writer, reader, sampler]) await c.end();

  // 4. Integrity and plans
  const after = await checksum();
  report.integrity = { identical: JSON.stringify(before) === JSON.stringify(after), before, after };
  report.constraintsAllValidated = (await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE NOT convalidated`))[0].n === 0;
  report.newObjects = (await q(`SELECT relname, relkind FROM pg_class WHERE relname IN ('match_run_holds','retention_runs','match_runs_created_idx','candidate_matches_professional_run_idx','retention_runs_started_idx') ORDER BY 1`)).map((r) => `${r.relname}(${r.relkind})`);
  await q('ANALYZE');
  const plan = async (sql: string, args: unknown[] = []) => (await q(`EXPLAIN (COSTS OFF) ${sql}`, args)).map((r) => r['QUERY PLAN'] as string).filter((l) => /Scan|Index/.test(l)).map((l) => l.trim());
  const proId = (await q(`SELECT professional_id FROM candidate_matches WHERE run_id IS NOT NULL LIMIT 1`))[0].professional_id as string;
  report.plans = {
    cleanupSelection: await plan(`SELECT r.id FROM match_runs r WHERE r.created_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM match_run_holds h WHERE h.run_id = r.id) ORDER BY r.created_at, r.id LIMIT 500`),
    erasureLookup: await plan(`SELECT 1 FROM candidate_matches WHERE professional_id = $1 AND run_id IS NOT NULL`, [proId]),
    resultsOfRun: await plan(`DELETE FROM candidate_matches WHERE run_id = ANY($1::uuid[])`, [[randomUUID()]]),
  };

  // 5. Rollback, byte-for-byte schema comparison, then the same migration again
  const rollbackSql = `
    DROP TRIGGER candidate_matches_hold_guard ON candidate_matches;
    DROP FUNCTION candidate_matches_hold_guard();
    DROP INDEX candidate_matches_professional_run_idx;
    DROP INDEX match_runs_created_idx;
    DROP TABLE retention_runs;
    DROP TABLE match_run_holds;
    DELETE FROM schema_migrations WHERE name = '0017_match_retention.sql';`;
  const [, rollbackMs] = await timed(() => db.transaction(async (tx) => { for (const st of splitSql(rollbackSql)) await tx.query(st); }));
  const afterRollback = await checksum();
  report.rollback = { ms: rollbackMs, schemaIdenticalToBefore0017: schemaDump(dbName) === schemaBefore, dataIdentical: JSON.stringify(afterRollback) === JSON.stringify(before), migrationRecordRemoved: (await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE name LIKE '0017%'`))[0].n === 0 };

  // 6. A migration that fails part-way leaves nothing behind
  const brokenDir = stage('0016'); const brokenPath = new URL('0017_match_retention.sql', brokenDir);
  writeFileSync(brokenPath, sqlText + '\nSELECT 1/0;\n');
  let failed = false;
  try { await migrate(db, brokenDir); } catch { failed = true; }
  report.failedMigration = {
    errored: failed, schemaIdenticalToBefore0017: schemaDump(dbName) === schemaBefore,
    migrationRecorded: (await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE name LIKE '0017%'`))[0].n > 0,
  };
  const [, reapplyMs] = await timed(() => migrate(db, stage('0017')));
  report.reapplyWithRepoMigrateMs = reapplyMs;

  // 7. Cleanup throughput, with the hold guard and without it, on the same shape of data
  await q(`INSERT INTO platform_settings (key, value) VALUES ('match_retention', '{"days": 200}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const preA = (await q(`SELECT count(*)::int AS runs FROM match_runs WHERE created_at < now() - interval '200 days'`))[0].runs as number;
  const [sumA, msA] = await timed(() => runMatchRetention(db, { mode: 'manual', userId, maxBatches: 1000 }));
  await q(`ALTER TABLE candidate_matches DISABLE TRIGGER candidate_matches_hold_guard`);
  await q(`UPDATE platform_settings SET value = '{"days": 100}'::jsonb WHERE key = 'match_retention'`);
  const preB = (await q(`SELECT count(*)::int AS runs FROM match_runs WHERE created_at < now() - interval '100 days'`))[0].runs as number;
  const [sumB, msB] = await timed(() => runMatchRetention(db, { mode: 'manual', userId, maxBatches: 1000 }));
  await q(`ALTER TABLE candidate_matches ENABLE TRIGGER candidate_matches_hold_guard`);
  report.cleanupThroughput = {
    withHoldGuard: { runsExpected: preA, ...pick(sumA), ms: msA, msPer1000Runs: Math.round((msA / Math.max(1, sumA?.runsDeleted ?? 1)) * 1000) },
    guardDisabledForComparison: { runsExpected: preB, ...pick(sumB), ms: msB, msPer1000Runs: Math.round((msB / Math.max(1, sumB?.runsDeleted ?? 1)) * 1000) },
    triggerRestored: (await q(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'candidate_matches_hold_guard'`))[0].tgenabled,
    decisionSnapshotsUntouched: (await q(`SELECT count(*)::int AS n FROM candidate_matches WHERE run_id IS NULL`))[0].n === SNAPSHOTS,
  };

  // 8. Restore the pre-migration backup into a new database and migrate it: the recovery path
  const restoreName = `${dbName}_restore`;
  await admin.query(`CREATE DATABASE ${restoreName}`);
  const [, restoreMs] = await timed(async () => { execFileSync(bin('pg_restore.exe'), ['--no-owner', ...dumpArgs(restoreName), dumpFile], { maxBuffer: 1 << 28 }); });
  const restored = createPgDb(urlFor(restoreName).toString());
  const rq = (sql: string) => restored.query<any>(sql);
  const restoredBefore = await Promise.all(['candidate_matches', 'match_runs', 'audit_logs'].map(async (t) => { const r = (await rq(`SELECT count(*) AS n, md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM ${t}`))[0]; return `${t}:${r.n}:${r.h}`; }));
  const [applied, restoreMigrateMs] = await timed(() => migrate(restored, stage('0017')));
  const restoredAfter = await Promise.all(['candidate_matches', 'match_runs', 'audit_logs'].map(async (t) => { const r = (await rq(`SELECT count(*) AS n, md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM ${t}`))[0]; return `${t}:${r.n}:${r.h}`; }));
  report.restore = { restoreMs, migrateAfterRestoreMs: restoreMigrateMs, applied, dataIdenticalAfterRestoreAndMigrate: JSON.stringify(restoredBefore) === JSON.stringify(restoredAfter) };
  await restored.close();
  await db.close();
  await admin.end();
  console.log(JSON.stringify(report, null, 2));
}
const pick = (s: Awaited<ReturnType<typeof runMatchRetention>>) => (s ? { runsDeleted: s.runsDeleted, resultsDeleted: s.resultsDeleted, batches: s.batches } : { runsDeleted: 0, resultsDeleted: 0, batches: 0 });
main().catch((e) => { console.error(e); process.exit(1); });
