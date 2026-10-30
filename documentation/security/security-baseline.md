# Security baseline (backend, as of Milestone 6)

Status key: **Implemented & tested** · **Implemented, not independently verified** · **Not implemented**

| Control | Status | Notes |
|---|---|---|
| Password hashing | Implemented & tested | argon2id; 12–128 character passwords; identical error and similar timing for unknown accounts |
| Sessions | Implemented & tested | Opaque random token in an HttpOnly, SameSite=Lax cookie (Secure in production); only a SHA-256 hash is stored; 7-day absolute and 12-hour idle expiry; logout, password reset and user suspension revoke sessions |
| Account abuse limits | Implemented & tested | Lockout after 5 failures; per-IP and per-account login limits; signup/forgot/apply/ticket limits; global per-IP limit on the whole API. **In memory, per process** |
| Email verification, password reset | Implemented & tested | Single-use hashed tokens; no account enumeration. Delivery needs an email provider (none yet) |
| MFA | Implemented & tested | TOTP, encrypted secrets, replay protection. Required for every platform role before any admin endpoint works. Any user can enable it; it is not mandatory for facility or professional users |
| Authorization | Implemented & tested | Server-side RBAC; organization membership looked up from the session on every request; non-members get 404; privilege-escalation guard on invitations and role changes; 47 endpoints verified to reject anonymous callers |
| Tenant isolation | Implemented & tested | Scoped queries + composite foreign keys (cross-tenant links rejected by the database). **Row-level security is not implemented** (see ADR 0004) |
| CSRF / CORS | Implemented & tested | SameSite=Lax cookies, Origin allowlist on state-changing requests, credentialed CORS only for the web and admin origins |
| Response headers | Implemented & tested | CSP `default-src 'none'`, nosniff, frame-deny, CORP same-site, no-store, HSTS in production |
| Input validation | Implemented & tested | zod schemas on every body/param/query; allowlisted sort/filter fields; parameterized SQL only; payload size limits |
| Error handling | Implemented & tested | Standard error shape with request id; no stack traces, SQL or provider details to clients |
| Field-level encryption | Implemented & tested | Credential numbers and MFA secrets: AES-256-GCM with separate keys supplied by environment variables |
| Private documents | Implemented & tested | Server-generated storage keys, type + magic-byte checks, size/count limits, owner/reviewer-only access, 60-second user-bound signed links re-authorized on download, access audited. **Local-disk storage is development only; no private-bucket adapter yet** |
| Malware scanning | Not implemented | Adapter exists; without a scanner files are stored `not_scanned` and labeled so |
| Audit logging | Implemented & tested | Append-only (database trigger) log of auth, review, admin and decision events; searchable by platform auditors; sensitive values excluded |
| Logging hygiene | Implemented & tested | Structured request logs contain route pattern, status, duration, request id and user id only; redaction of secrets; verified against a full register/login/reset/upload flow |
| Web and admin apps | Built; not browser-tested by a person | Pages never hold secrets or talk to the database; the session cookie is HttpOnly and not readable by scripts; `?next=` redirects are limited to same-site paths; controls are hidden by role but the server decides; staff tools require a platform role *and* a verified MFA session; the admin app is `noindex` and `no-store`. Both send a CSP (with `'unsafe-inline'` scripts, which Next.js needs; a nonce-based CSP is a follow-up), frame-deny and nosniff. The two apps share the API's session cookie (ASSUMPTIONS #32) |
| Facility talent search | Implemented & tested | Opt-in, anonymized cards, per-organization references, invitations only; every search audited and rate limited (ADR 0005). Re-identification from combined fields is a residual risk |
| Monitoring | Implemented, per process | Request metrics at `/admin/metrics`, `/health`, `/ready`. No external alerting is wired up (see runbook) |
| Backups | Procedure documented; restore validated on the embedded database only | See the operations runbook |
| Dependency scanning | Run manually | `npm audit --omit=dev`: 0 vulnerabilities. Dev tooling (vitest 3) has advisories; fixing needs a major upgrade. No CI job yet |
| Secrets | Environment variables only | `.env.example` has names only. No secrets manager integration |
| TLS, encryption at rest, network controls | Out of scope here | Deployment responsibilities (reverse proxy / managed Postgres / bucket) |
| External penetration test | Not done | Required before real users |

## Known gaps that block a real pilot
1. Row-level security (defence in depth) and a staging run against real PostgreSQL.
2. Shared rate-limit store, email provider with retries, malware scanner, private object storage.
3. Legal/privacy review (HIPAA applicability, state privacy law, retention, automated-decision rules): see `ASSUMPTIONS.md`.
4. Independent security review and penetration test; incident-response contacts and on-call.
