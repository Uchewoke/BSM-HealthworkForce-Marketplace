# Deploying match-run retention (migration 0017) safely

For ADR 0009. Evidence from the rehearsal on PostgreSQL 18.3 is in `documentation/security/match-retention-production-readiness.md`. This procedure keeps automatic cleanup **off** until a person has watched the first deletions succeed.

Roles: an engineer with database access, and a super admin (MFA enrolled) for the admin endpoints. Do not start unless counsel has seen the retention period and legal-hold wording (ASSUMPTIONS #62-65), or you accept that the 90-day default is provisional.

## 0. Before anything
1. Take a full database backup and **restore it into a scratch database** to prove it works. Note the time.
2. Count what exists: `SELECT count(*) FROM match_runs; SELECT count(*) FROM candidate_matches WHERE run_id IS NOT NULL; SELECT count(*) FROM candidate_matches WHERE run_id IS NULL;` (the last number is decision snapshots, which cleanup never touches).
3. Confirm the production build you will deploy passes `npm run typecheck`, `npm test` and `npm run build`.

## 1. Rehearse on a copy of production
Restore the backup from step 0 into a database named `rehearsal_<anything>` on a non-production server, then:
```
# Apply and time the migration statement by statement; it prints locks taken, writer stalls, plans, rollback and restore results.
REHEARSAL_ADMIN_URL=postgres://<admin>@<host>:<port>/postgres PG_BIN=<path to postgres bin> \
  npx tsx backend/src/scripts/rehearse-match-retention.ts
```
That script builds its own synthetic database; for a production copy, run the same steps by hand: `npm run migrate -w @bsm/backend` with `DATABASE_URL` pointing at the copy, time it, and compare row counts and `pg_dump --schema-only` before and after. Do not continue if the migration takes longer than your write-stall budget (see section 2) or if any step fails.

## 2. Migrate production (additive, in a quiet window)
The migration creates two tables, a function and trigger, and two indexes. It changes no existing row.

**What it locks (measured in the rehearsal, see the report):** the migration first takes a SHARE ROW EXCLUSIVE lock on `match_runs` and then `candidate_matches`, in that order, and holds both until it commits.
- **Writes to those two tables wait** (they do not fail) for the whole migration; reads continue. The wait is dominated by the index build on `candidate_matches`, which grows roughly in line with its row count. Writers include `POST …/match-runs` **and** the decision snapshots written when a professional applies, an offer is sent, or an offer is accepted, so those actions pause for the duration. Choose a quiet window.
- **The order matters.** It matches the order the application's own transactions use. Taking the two locks in the opposite order produced a real deadlock against live writers in a rehearsal; the up-front, same-order lock removes that, and `tests/match-retention.pg.test.ts` applies the migration under live write traffic to keep it that way.
- **It gives up cleanly rather than hanging.** `lock_timeout` is 30 seconds. If a long-running transaction holds a conflicting lock, the migration fails with "canceling statement due to lock timeout", having changed nothing. Find and finish that transaction (`SELECT pid, state, query_start, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start`) and run it again.
- The new tables' foreign keys also take a brief SHARE ROW EXCLUSIVE lock on `users` (writes to `users`, such as login counters, wait for those last milliseconds).

**Large tables.** If `candidate_matches` is much larger than the rehearsal (about 780,000 rows built in about 3 seconds), pre-build both indexes without blocking writes, then run the migration, which skips them (`IF NOT EXISTS`):
```
CREATE INDEX CONCURRENTLY IF NOT EXISTS candidate_matches_professional_run_idx ON candidate_matches (professional_id) WHERE run_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS match_runs_created_idx ON match_runs (created_at);
SELECT indexrelid::regclass AS idx, indisvalid FROM pg_index WHERE indexrelid::regclass::text IN ('candidate_matches_professional_run_idx','match_runs_created_idx');
```
Every row must show `indisvalid = true`. A failed concurrent build leaves an **invalid** index that `IF NOT EXISTS` would silently accept: `DROP INDEX` it and build again before migrating. `CONCURRENTLY` cannot run inside a transaction, so run these statements on their own (for example with `psql`), not through `npm run migrate`.

**Run:** `npm run migrate -w @bsm/backend` with the production `DATABASE_URL`. It is transactional: a failure leaves the database as it was. Old application code keeps working against the new schema (it uses nothing that changed), so migrate **before** deploying code.

## 3. Deploy the code with cleanup off
Set `MATCH_RETENTION_INTERVAL_HOURS=0` in the API environment and deploy. The admin endpoints exist but nothing runs on a timer.

## 4. Verify, still with cleanup off (super admin)
Record each response.
1. `GET /api/v1/admin/match-retention/settings` → `days: 90, version: 0`.
2. `GET …/history` → empty. `GET …/holds` → empty.
3. `POST …/cleanup {"dryRun": true}` → check `runsExpired`, `resultsExpired` against SQL: `SELECT count(*) FROM match_runs WHERE created_at < now() - interval '90 days'`. They must agree. Check `runsHeld` is 0. In the database, `SELECT action, metadata FROM audit_logs WHERE action = 'admin.match_retention_previewed' ORDER BY created_at DESC LIMIT 1` must show counts and no personal data.
4. Hold check on a **recent** run: `PUT …/holds {"runIds": ["<recent run id>"], "reason": "Deployment check"}`, then `DELETE …/holds/<id>`. Audit shows `admin.match_hold_placed` and `admin.match_hold_released`.
5. Erasure dry run on a test professional: `POST …/erasure {"professionalId": "<test id>"}` (defaults to a dry run). The counts must be plausible; nothing changes.
6. Confirm a non-super-admin (a platform admin, a facility owner) gets 403 on all of the above.

## 5. First real cleanup: walk the period down
Never go straight to the target. Take a fresh backup, then for each of 365, 180, then 90 days:
1. `PUT …/settings {"days": N}`.
2. `POST …/cleanup {"dryRun": true}` and read the counts.
3. `POST …/cleanup {}` (runs now, in batches). If `moreRemaining` is true, run it again.
4. Check `GET …/history` shows `completed` with the expected counts, and in SQL that these did not change: `applications`, `assignments`, `credentials`, `shift_offers` row counts, and `SELECT count(*) FROM candidate_matches WHERE run_id IS NULL` (decision snapshots), and that `audit_logs` only grew.
5. Stop and investigate on any `failed` entry (`error_code` is the error class; the API log has the same, never messages).
Wait at least a day between steps if the counts are large.

## 6. Enable the schedule
Only after step 5 succeeded at the target period:
1. Set `MATCH_RETENTION_INTERVAL_HOURS=24` (or your choice) and restart **one** instance first.
2. About a minute after start, `GET …/history` shows an entry with `mode: scheduled`, `status: completed`. Then restart the rest. A database lease means several instances cannot overlap.
3. Add an alert on `retention_runs.status = 'failed'` and on no `completed` entry in the last 48 hours.

## 7. Roll back
- **Stop the deletions:** set `MATCH_RETENTION_INTERVAL_HOURS=0` and restart. Manual cleanup still needs a super admin to call it.
- **Remove the schema (only if you must):** export `match_run_holds` and `retention_runs` first (they record legal holds and what ran), then run in one transaction:
```
DROP TRIGGER candidate_matches_hold_guard ON candidate_matches;
DROP FUNCTION candidate_matches_hold_guard();
DROP INDEX candidate_matches_professional_run_idx;
DROP INDEX match_runs_created_idx;
DROP TABLE retention_runs;
DROP TABLE match_run_holds;
DELETE FROM schema_migrations WHERE name = '0017_match_retention.sql';
```
  The rehearsal verified this returns the schema to its exact pre-0017 state.
- **Deleted data cannot be rolled back.** Recovery is restoring a backup into a separate database and copying the needed rows. After any restore, re-run pending erasure requests and a cleanup before use.
- A failed or interrupted migration needs no rollback: it is atomic.
