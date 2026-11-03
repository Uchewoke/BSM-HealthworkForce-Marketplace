# Operations runbook (backend)

> **Status:** written during Milestone 6 and **not yet exercised against a real PostgreSQL deployment** (Docker was unavailable on the
> development machine; all automated tests use the embedded PGlite). Run every procedure below in staging before relying on it.

## 1. Configuration
Required environment variables are listed in `.env.example`. Production must set `NODE_ENV=production`, `DATABASE_URL`,
`WEB_URL`, `ADMIN_URL`, `MFA_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY` (32 random bytes each, base64, **different** values) and a private
file store. **The server refuses to start in production** until a real email provider adapter and private-bucket storage adapter exist
(`backend/src/server.ts`); this is intentional so nothing pretends to send email or keeps documents on local disk.
Losing `FIELD_ENCRYPTION_KEY` makes credential numbers unrecoverable; losing `MFA_ENCRYPTION_KEY` forces every MFA user to re-enroll.
Back both keys up separately from the database backups.

## 2. Deploy and roll back
1. Take a fresh backup (section 3). 2. Deploy the new build. 3. Run `npm run migrate -w backend` (applies pending `backend/migrations/NNNN_*.sql`,
each in a transaction, recorded in `schema_migrations`). 4. Check `GET /api/v1/ready` and `GET /api/v1/health`.
**Migrations are forward-only (no down scripts).** Rolling back application code is safe while the schema change was additive
(all migrations so far are additive except two constraint replacements in `0006`). For anything else, roll back by restoring the backup
taken in step 1. Never edit an applied migration; add a new one.

## 3. Backups and restore
- Use managed PostgreSQL with automated daily snapshots **and** point-in-time recovery, encrypted at rest. Keep at least 14 days; store copies in a second region/account.
- Logical backup (for migration rehearsals and ad-hoc safety): `pg_dump --format=custom --no-owner "$DATABASE_URL" > bsm-$(date +%F).dump`.
- Private document files live in object storage, **not** in the database: enable versioning and cross-region replication there too, and back up the bucket on the same schedule. A database restore without the matching files leaves documents missing.
- **Restore drill (monthly, and before the first pilot):** create an empty database, `pg_restore --no-owner --dbname "$STAGING_URL" bsm.dump`, point a staging API at it, run `npm run migrate -w backend` (should report "No pending migrations"), then verify `GET /ready`, a known user can sign in, the audit-log trigger still blocks `UPDATE audit_logs`, and row counts match production. Record the date, duration and result.
- What is automated today: `tests/hardening.test.ts` dumps an embedded database, restores it, and checks the migration ledger, row counts, the audit trigger, foreign keys and sign-in. That validates the schema and constraints survive a dump/restore cycle; it does **not** validate `pg_dump`/`pg_restore`, PITR, or object-store recovery.

## 4. Monitoring and alerting
Sources: structured JSON request logs (one line per request: route pattern, status, duration, request id, user id; no bodies or secrets),
`GET /api/v1/health` (liveness), `GET /api/v1/ready` (database), and `GET /api/v1/admin/metrics` (per-process counters; super admin).
Ship logs to a central store and aggregate metrics across instances. Suggested starting alerts (tune with real traffic):

| Signal | Alert |
|---|---|
| `/ready` fails | page after 2 consecutive failures (1 min) |
| 5xx rate | > 1% of requests over 5 minutes |
| p95 latency | > 2 s over 10 minutes (`latency` buckets) |
| HTTP 429 volume | sudden 5× rise (abuse or a misbehaving client) |
| `auth.login_failed` / `auth.login_blocked_locked` audit actions | spike vs. baseline (credential stuffing) |
| `application.transition_refused_ineligible` | informational: a facility tried to proceed with an ineligible candidate |
| Unhandled errors (`"msg":"unhandled error"`) | any occurrence → ticket |
| Disk / DB connections / backup job status | provider alarms; failed backup → page |

No alerting is configured in code. Someone must own these alerts before pilot.

## 5. Incident response (basics)
1. **Triage:** classify (availability, data exposure, account compromise, abuse). Start a timeline (UTC) with the request ids and audit-log entries involved.
2. **Contain:** suspend affected users (`POST /admin/users/:id/status`, revokes sessions), pause or close offending listings (`POST /admin/jobs/:id/status`), disable a state (`PUT /admin/states/:state`) if needed. To invalidate all sessions: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL`.
3. **Investigate:** audit-log search (`GET /admin/audit-logs`) by actor, action prefix, target and time window; request logs by request id.
4. **Key compromise:** rotate `MFA_ENCRYPTION_KEY` / `FIELD_ENCRYPTION_KEY` (requires a re-encryption script, **not yet written**), force password resets, and rotate any provider credentials.
5. **Notify** according to counsel's guidance (state breach-notification laws, contractual duties): decisions that need qualified legal input, see `ASSUMPTIONS.md`.
6. **Review:** write a post-incident note; add a test for the failure.
Contacts, on-call rota and escalation paths are **not defined** and must be filled in by the product owner.

## 6. First administrator
`BSM_ADMIN_PASSWORD='<12+ chars>' npm run create-admin -w backend -- you@example.com "Your Name" platform_super_admin`, then sign in and enroll MFA (`POST /auth/mfa/setup`, `/auth/mfa/confirm`). Never seed a default admin password. Unset the variable afterwards.

## 7. Data retention
**Match runs** expire automatically (ADR 0009). Deploy and enable them with `documentation/operations/match-retention-deployment.md`, which keeps the timer off until a person has watched the first deletions. Everything else has no retention job yet (assumption #8); audit logs are append-only by design, so plan archival rather than deletion.

- **Period:** default 90 days. Change with `PUT /admin/match-retention/settings {"days": N}` (super admin, 30 to 3650). Counsel should confirm the value (assumption #62).
- **Schedule:** the API runs cleanup daily (`MATCH_RETENTION_INTERVAL_HOURS`, 0 turns it off), first about a minute after start. Several API servers are safe: a database lease (`scheduler_leases`, name `match_retention`) lets one run at a time, and it expires by itself after 15 minutes if a server dies.
- **Preview, run, and check:** `POST /admin/match-retention/cleanup {"dryRun": true}` shows what would be deleted and what is held; without `dryRun` it runs now. `GET /admin/match-retention/history` lists executions (status, counts, error class only). A `failed` entry means the next pass retries; the API log line is "match retention pass failed" (error class only).
- **Large backlog:** one execution does at most 200 batches of 500 runs and reports `moreRemaining: true`; run it again or wait for the next pass.
- **Legal hold:** `PUT /admin/match-retention/holds {"runIds": [...], "reason": "Matter 2026-114"}` before the run expires (an expired, deleted run cannot be held). Use a matter or ticket reference, never personal details. Release with `DELETE /holds/:runId`; the run is then deleted at the next pass if it has expired. A held run also blocks erasure of its results until released: only release on counsel's instruction.
- **Erasure request for matching data:** (1) `POST /admin/match-retention/erasure {"professionalId": "...", "reference": "DSR-..."}` is a dry run; check the counts and `resultsHeld`. (2) Repeat with `"dryRun": false`. (3) If `stillDiscoverable` is true the person can reappear in future runs: they must turn off discoverability or their account must be closed. This does **not** erase the account, applications, decision snapshots, credentials or audit entries, and backups keep their copies until they expire. Do not tell the requester their data is erased until those other steps are done.
- **Restore from backup:** a restore can bring back deleted runs and erased results. After any restore, re-run the pending erasure requests and a cleanup before the system is used again.
- **Disable temporarily:** set `MATCH_RETENTION_INTERVAL_HOURS=0` and restart. Manual cleanup still works.
