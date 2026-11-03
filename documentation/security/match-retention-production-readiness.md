# Match-run retention: production-readiness validation

Date: 2026-11-02. Scope: migration `0017_match_retention.sql`, the retention and erasure service (ADR 0009), and their admin API. Eligibility rules, ranking factors and weights were not changed.

## Verdict

**Ready for a controlled pilot of the retention feature, with conditions. Not ready to enable cleanup in production today.**

1. The feature passed every functional, concurrency, migration, rollback and recovery check on a real PostgreSQL 18.3 server, after four defects found by this validation were fixed (below).
2. **Nothing can be deployed to production yet, for reasons outside this feature:** `backend/src/server.ts` deliberately refuses to start with `NODE_ENV=production` until an email adapter and a private object-storage adapter exist. That is a pre-existing, documented gate (runbook section 1).
3. **Conditions before enabling cleanup:** rehearse on a restored copy of production data (the rehearsal here used synthetic data, ASSUMPTIONS #66); follow `documentation/operations/match-retention-deployment.md` (timer off, walk the period down, then enable); counsel confirms the 90-day period and hold rules (#62-65).
4. It is **not account erasure** and must not be described as such (ADR 0009, ASSUMPTIONS #64).

## Environment and what "production-like" means here

PostgreSQL 18.3 (Windows x86-64), a throwaway local cluster with default durability settings (fsync on). Synthetic data with the right shape: 20,000 professionals with applications, 300,000 decision snapshots, 40,000 match runs with 480,000 results (771,670 `candidate_matches` rows), 400,000 audit rows, all foreign-key valid. Real tables will differ in size, distribution and hardware; times scale with row counts. Everything here is reproducible with `backend/src/scripts/rehearse-match-retention.ts` and `backend/tests/match-retention.pg.test.ts`.

## Task A: build and tests

| Check | Result |
|---|---|
| `npm run build` (root, all workspaces) | **Passes** (exit 0): backend `tsc`, admin and web `next build` |
| `npm run typecheck` | **No errors** in 4 workspaces |
| `npm test` (embedded database) | Backend **431 passed, 6 skipped** (the 6 skipped are the real-PostgreSQL concurrency tests, which need `TEST_DATABASE_URL`); UI 30, other workspaces 7, 6, 9 passed |
| Retention, match-run and concurrency suites on real PostgreSQL 18.3 | **43 of 43 passed** (`match-retention.pg.test.ts` 5, `match-retention.test.ts` 21, `match-runs.test.ts` 17), and the migration-under-traffic test passes standalone |
| Whole backend suite on real PostgreSQL 18.3 | See "Whole suite on PostgreSQL" below |

### Whole suite on PostgreSQL
Run with `TEST_DATABASE_URL` set, `--maxWorkers=3 --testTimeout=120000 --hookTimeout=120000`, 717 s: **437 tests, 436 passed, 1 failed; 31 of 32 files passed.** The one failure is the time-of-day flake described below, not a PostgreSQL difference (it fails identically on the embedded database). Everything else, including every suite that ran only on the embedded database before, passes on the production engine.

A first attempt with 4 workers and default timeouts failed 13 files. That was test-infrastructure contention, not product failures: every test app created its own database, and on this Windows disk `CREATE DATABASE` took tens of seconds when several started at once (even PGlite-only tests timed out). The helper now creates a schema per test app (no checkpoint), which fixed it. Under load the migration-under-traffic test still took 43-75 s per `CREATE DATABASE ... TEMPLATE` and passed within its 300 s limit (52 writer transactions committed, 0 deadlocks, 0 lock timeouts).

### A pre-existing time-of-day flake (not caused by this work)
`tests/shift-recovery.test.ts` > "does not start new automatic offers right before the shift" fails when it starts between about 22:30 and 23:00 America/New_York (the shift begins one hour later and so straddles midnight), on both the embedded database and PostgreSQL. It passed 16 of 16 when rerun at 23:14. It creates a 30-minute shift starting one hour from now and gives every professional a daily `00:00-23:59` availability window, so a shift that crosses midnight (or starts in the 23:59-00:00 gap) is correctly refused with 409. Proved with the real availability function: a 20:00-20:30 shift is accepted, 23:49-00:19 is not, 23:20-23:50 is. The file is unmodified by this work and passed in my earlier full runs. Not fixed here (out of scope); a robust fix is to give the test professionals an overnight window as well.

One earlier full embedded run (started about 22:56 ET) also reported this file failing at file level with its 16 tests skipped. I had filtered that run's output and did not capture the error, so its cause is **unconfirmed**; the clock-relative shifts are the leading suspect. The file passed alone at 23:14 and in a complete rerun that retained its log: **31 files passed, 431 tests passed, 6 skipped (the PostgreSQL-only tests)**. Treat the file as time-sensitive until its setup is made clock-independent.

## Task B: migration rehearsal (PostgreSQL 18.3, final migration)

| Item | Evidence |
|---|---|
| Duration | `0017`: **3.2 s** total at 771,670 `candidate_matches` rows and 40,000 runs; **2.96 s** of that is one index build on `candidate_matches`. Re-apply through the repo's `migrate()`: 2.4 s; after a restore: 4.0 s. (`0016` over the same legacy data: 3.9-6.1 s across runs) |
| Locks (sampled from `pg_locks`) | SHARE ROW EXCLUSIVE / SHARE on `match_runs` and `candidate_matches` for the whole migration; a brief SHARE ROW EXCLUSIVE on `users` (the new tables' foreign keys) |
| Effect on concurrent traffic | A concurrent writer's insert **waited 3.3 s and then succeeded** (it did not fail); median write latency was about 31 ms before, and at most 39 ms after. Reads were unaffected (max 5 ms) |
| Index creation | `candidate_matches_professional_run_idx` (partial, 2.96 s) and `match_runs_created_idx` (0.1 s); both `IF NOT EXISTS`, so they can be pre-built `CONCURRENTLY` on huge tables |
| Existing data integrity | Row counts and md5 over ids of `candidate_matches`, `match_runs`, `audit_logs` **identical** before and after; all constraints validated |
| Query plans | Cleanup selection uses `match_runs_created_idx` (index scan); erasure lookup uses `candidate_matches_professional_run_idx` (index-only scan); deleting a run's results uses `candidate_matches_run_idx` |
| Rollback | A written rollback script ran in **95 ms**; `pg_dump --schema-only` before 0017 and after rollback are **identical**, data checksums identical, migration record removed. Re-applying works |
| Failed migration | A migration with a deliberate error at the end left **nothing behind** (schema identical, no migration record): DDL is transactional |
| Backup and recovery | `pg_dump -Fc` of the pre-0017 database: 42 s; `pg_restore` into a new database: **254 s**; migrate afterwards: 4.0 s; data identical. Plan recovery time accordingly (1.5 million rows here) |
| Cleanup throughput | 13,433 expired runs / 161,196 results deleted in 27 batches in **13.1 s** (about 1 s per 1,000 runs); the same job with the hold-guard trigger disabled took 12.3 s, so the guard costs about 6%. Decision snapshots untouched |

The earlier rehearsals also found problems, now fixed: the first run failed at restore because my synthetic seed bypassed foreign keys (the script now builds real parents), and a reordered migration **deadlocked against live writers** (see defects).

## Task C: legal-hold concurrency (real PostgreSQL, separate connections)

All in `backend/tests/match-retention.pg.test.ts`; interleavings are forced with explicit transactions, not timing luck.

| Scenario | Result |
|---|---|
| Delete a held run directly | Refused by the foreign key (`23503`) |
| Delete a held run's results directly, singly or mixed with un-held runs in one statement | Refused by the database trigger; the whole statement rolls back |
| Hold arrives while cleanup has the run locked | The hold **waits**, cleanup finishes, the hold is then refused cleanly; never a held run that lost data |
| Hold commits while the real cleanup waits for the lock | Cleanup **skips** that run, deletes the others in the batch, ends `completed` |
| Erasure races a hold | Held results kept; the references explaining them kept |
| 240 randomized hold-vs-cleanup races (six runs of 40) | Invariant held every time: a held run always keeps every result and an un-held expired run is always fully gone. The first two runs used a narrow delay and mostly exercised one ordering (36 and 40 held-intact); after widening the hold's delay both orderings occurred in every run (held-intact 19-24, deleted 16-21, hold refused 6-11 per 40) |
| Migration under live write traffic (3-4 rounds, 3 writers) | 72-104 writer transactions committed, **0 deadlocks, 0 lock timeouts, 0 other errors** |

**Mutation checks** (the tests can fail): restoring the old cleanup locking made the "hold commits while cleanup waits" test fail; removing the guard trigger made the database-level test fail ("promise resolved instead of rejecting"); removing the up-front table lock made the migration-under-traffic test fail with "deadlock detected" twice out of two.

## Task D: erasure regression (embedded database and PostgreSQL)

In `backend/tests/match-retention.test.ts`:
- Erasing an existing professional removes their results and references; an unrelated professional's rows (profile, preferences, credentials, applications, results, references) have an **identical fingerprint** before and after; the account row itself is untouched.
- Erasing when the account **no longer exists** (the professional row deleted): orphaned results are found by value and removed; dry run changes nothing; a repeat finds nothing.
- Future matching: a discoverable professional is matched, erased, and **matched again** (erasure alone does not stop that; the response says `stillDiscoverable: true`). After opt-out, a suspended user, or a restricted profile, **new runs exclude them**; restoring the state includes them again; a deleted professional cannot appear.
- Held results are kept, and so are the references; releasing the hold lets the erasure complete.

## Task E: deployment readiness

`documentation/operations/match-retention-deployment.md`: backup and restore test, rehearsal, a quiet-window migration (locks explained, pre-building indexes `CONCURRENTLY` for large tables), deploy with `MATCH_RETENTION_INTERVAL_HOURS=0`, a verification checklist (settings, dry-run counts against SQL, hold place and release, erasure dry run, access denial, audit events), walking the period down 365, 180, 90 days with SQL checks that applications, assignments, credentials, offers and decision snapshots are unchanged, then enabling the schedule on one instance, then rollback. Dry-run output and audit events are asserted in the test suite (counts only; no names, emails, references to personal data).

Real-server boot check: `src/server.ts` booted against a fresh PostgreSQL database, applied all migrations through 0017 and served health checks, with the timer off and with it on; the timer-off instance recorded no run. The timer-on instance's first scheduled run was **not conclusively observed** (the check fell on the 60-second edge), so enabling the schedule on one instance and watching `GET /history` (deployment guide, step 6) is a required step, not a formality. The timer function itself is proven by a test on both engines.

## Defects found by this validation (all fixed, each with a test)

1. **Results of a held run could be deleted directly.** Only the run row was protected. A statement-level trigger now refuses it.
2. **Cleanup missed a hold that committed while it waited for the row lock** (it checked holds in the same statement that locked the row, using an older snapshot) and the batch failed. It now locks first and checks second.
3. **The migration deadlocked against live writers** when it locked tables in the opposite order to the application. It now takes both table locks up front in the application's order, with a 30-second `lock_timeout`.
4. **An unfinished-batch edge:** a batch whose runs were all held in the meantime stopped the whole pass early. It now continues.

## Remaining risks

**High**
- No production deployment is possible yet (email and private-storage adapters missing; `server.ts` refuses production mode). Pre-existing.
- Account erasure does not exist. Erasure here covers matching data only; backups, audit entries, the account, applications and decision snapshots are not covered (ASSUMPTIONS #64).

**Medium**
- The rehearsal used synthetic data on a local server. Production table sizes and hardware change the write pause (ASSUMPTIONS #66). The migration pauses writes to `match_runs` and `candidate_matches`, which includes applying, offers and acceptance (they wait, not fail). Mitigations: quiet window, pre-built concurrent indexes, `lock_timeout`.
- Recovery time: restoring a 1.5-million-row database took 254 s here; production recovery objectives need their own measurement.
- Decision snapshots, applications and run history have no retention period yet (ASSUMPTIONS #62).
- The retention timer lives in the API process (a database lease stops overlap); scheduled execution inside the real server was not conclusively observed (see Task E).
- The flaky `shift-recovery` test (above) will fail a CI run at certain hours.

**Low**
- Cleanup is an ordinary row delete; space is reclaimed by vacuum, not wiped.
- A hold placed after a run has expired and been deleted cannot be applied; place holds early.
- The admin controls are API-only.

## Housekeeping to report

- Two idle development servers (PIDs 3908 and 6628, plus their launchers) are left running on ports 4201 and 4202 from my smoke test: its tree-kill did not reach them, and a bulk stop was denied by the permission system, so I left them for you to stop. Their databases were already dropped.
- A throwaway PostgreSQL cluster is still running on port 55432 with data under the session scratchpad.
- Nothing is committed.
