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
No retention or deletion jobs exist. Periods must be set with counsel (assumption #8). Audit logs are append-only by design; plan archival rather than deletion.
