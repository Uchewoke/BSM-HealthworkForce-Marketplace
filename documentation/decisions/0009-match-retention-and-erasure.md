# ADR 0009: Retention and erasure of match-run data

Status: accepted (2026-11-02). Retention period and hold rules are pending counsel review (ASSUMPTIONS #62-65). Builds on ADR 0008.

## Context
Match runs (ADR 0008) store eligibility details and, for applicants, link to names. They were kept indefinitely. The repository had no retention job, no legal hold concept and no account deletion or erasure process (only `active`/`suspended` users and deletion of profile sub-records).

## Decision
1. **Retention.** A match run and its results are deleted when the run is older than the configured period. The period is `platform_settings.match_retention` (`{"days": N}`, bounded 30-3650, default 90 in one constant), changed by a super admin and audited. Age is the run's `created_at`.
2. **Scope.** Only `match_runs` and `candidate_matches` rows that belong to a run. Not touched: applications, offers, assignments, credentials, accounts, audit logs, and the apply/offer/accept decision snapshots (rows without a run), which are part of the hiring decision record.
3. **Mechanics.** Batches of 500 runs, each in its own transaction: lock the runs (`FOR UPDATE`), delete results, delete runs. Idempotent. At most 200 batches per execution. A database lease (`match_retention`) prevents overlap across servers; the timer runs daily (`MATCH_RETENTION_INTERVAL_HOURS`, 0 = off). History (`retention_runs`) and audit entries carry counts, status and an error class name, never messages or personal data.
4. **Legal hold.** `match_run_holds`: one row per held run, with a short reference and who placed it. Held runs are skipped by cleanup and by erasure. Protection is layered, and each layer is tested on its own against real PostgreSQL:
   - A foreign key from the hold to the run stops the database deleting a held run.
   - A statement-level trigger on `candidate_matches` refuses any DELETE that would remove a result belonging to a held run, whoever issues it (cleanup, erasure or hand-written SQL). The first design protected only the run row, so its results could still be deleted directly; the concurrency review found that gap.
   - Cleanup and erasure lock the affected runs (`FOR UPDATE`) and only then check holds in a separate statement. Placing a hold needs a key-share lock on the run, which waits for that lock, so a hold and a cleanup at the same moment cannot both win. Checking in the same statement as the lock was a defect: a hold that committed while cleanup waited was missed and the batch failed (safely, because of the layers above, but it failed).
5. **Professional erasure of matching data.** Deletes the professional's results in un-held runs and their `talent_refs` rows (all of them, unless any of their results is held, in which case the references are kept because they explain the held evidence). Dry run by default. Idempotent. Works for a professional whose account no longer exists, since results are linked by value (no foreign key). Returns counts only, plus whether the person is still discoverable.
6. **Authorization.** `/admin/match-retention`, `admin.settings_manage` (super admin) with MFA: the permission that already governs ranking weights. No new permission. Every action is audited; a dry run writes only its audit entry.

## Migration and validation
- Migration `0017` is additive and transactional. It takes a SHARE ROW EXCLUSIVE lock on `match_runs` then `candidate_matches` up front (the order the application's own transactions use) with a 30-second `lock_timeout`, so writes to those tables wait while it runs and it fails cleanly instead of hanging. Taking the locks one statement at a time, in the opposite order, deadlocked against live writers in a rehearsal; the migration is now applied under live write traffic in a test.
- Rehearsed on PostgreSQL 18.3 with about 770,000 `candidate_matches` rows, 40,000 runs and 400,000 audit rows: apply, per-statement timing, locks, integrity checksums, query plans, rollback (schema and data byte-identical), a deliberately failing migration (nothing left behind), cleanup throughput, and backup, restore and re-migrate. Figures and caveats are in `documentation/security/match-retention-production-readiness.md`; the procedure is `documentation/operations/match-retention-deployment.md`.
- Both indexes use `IF NOT EXISTS` so an operator can pre-build them `CONCURRENTLY` on a very large table.

## What this does not do
- It is **not account erasure.** No such process exists. The account, profile, credentials, applications and the decision snapshots remain.
- It does not stop a person appearing in future runs; they must turn off discoverability or close the account.
- It cannot reach database backups, copies facilities already saw, or the audit log. Audit entries keep the opaque professional id and the request reference so the action stays accountable; they contain no name or contact detail.
- Deleted rows are reclaimed by normal database vacuum, not secure-wiped.
- No UI: the controls are API-only for now.

## Alternatives considered
- Cascade foreign keys from runs to results: rejected; it would need a constraint rewrite on an existing table, and explicit ordered deletes are clearer and testable.
- Hold columns on `match_runs`: rejected; it would weaken the update protection.
- A broad compliance subsystem (holds on any table, approval workflows): out of scope until counsel defines what holds must cover.
