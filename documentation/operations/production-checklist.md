# Production readiness checklist

Written 2026-11-16 against the code as it is today. Every item was checked against the repository, not assumed. Tick an item only
when a named person has done it and recorded the evidence (date, link, or command output). Sources: `README.md` "What is not
done", `documentation/security/security-baseline.md`, `documentation/operations/runbook.md`, `infrastructure/deployment/README.md`,
`ASSUMPTIONS.md`, and the code under `backend/src`.

Status key: **BLOCKER** = the deployment cannot start or must not take real users without it. **REQUIRED** = must be done before
the first pilot. **RECOMMENDED** = do soon after.

---

## 0. Hard stops (the API will not boot in production today)

These are enforced in code, not policy. Until they are done, the API container refuses to start (`NODE_ENV=production` is set in
`infrastructure/deployment/droplet/compose.yml`).

- [x] **BLOCKER. Implement a real `EmailSender`.** Done 2026-11-16: `ResendEmailSender` and `PostmarkEmailSender` in
      `backend/src/integrations/email.ts` (retries with backoff, never claims sent unless accepted, token only in the link).
      Still to do by you: choose the provider, set `EMAIL_PROVIDER`, `EMAIL_FROM` and the key, verify the sending domain with SPF,
      DKIM and DMARC, and send one real verification email from staging.
- [x] **BLOCKER. Implement a `PrivateFileStorage` adapter.** Done 2026-11-16: `S3PrivateStorage` in
      `backend/src/integrations/storage.ts` for any S3-compatible bucket; local disk is refused in production. Still to do by you:
      create the bucket per `infrastructure/storage/README.md` (private, encrypted, versioned, replicated, least-privilege key) and
      set `STORAGE_*`.
- [x] **BLOCKER. Wire the adapters in `createRuntimeDeps`.** Done 2026-11-16: production boots when email, storage and the
      rate-limit store (shared, or `RATE_LIMIT_STORE=memory` on the single Droplet process) are configured and otherwise throws one
      error naming every missing variable (`tests/runtime.test.ts`).
- [ ] **BLOCKER. `DATABASE_URL` set to DigitalOcean Managed PostgreSQL**, connection-pool endpoint, with
      `sslmode=verify-full&sslrootcert=/run/ca/db-ca.crt` and the cluster's CA saved as `droplet/db-ca.crt` (the pool in
      `backend/src/db/index.ts` passes no `ssl` option; this `pg` version verifies the chain even for `sslmode=require`, so the CA
      is needed either way). Add the Droplet as a trusted source on the cluster so nothing else can reach it.
- [ ] **BLOCKER. Generate and set `MFA_ENCRYPTION_KEY` and `FIELD_ENCRYPTION_KEY`** (`openssl rand -base64 32`, two different
      values). Store copies in a secrets manager separate from database backups. Losing the field key makes credential numbers
      unrecoverable; losing the MFA key forces every MFA user to re-enroll.
- [ ] **BLOCKER. Set `WEB_URL` and `ADMIN_URL`** to the public origin(s). Both feed the CORS allowlist, the Origin check and email
      links. Both share the Vercel origin (`https://app.example.com` and `https://app.example.com/admin`); the API itself lives on
      `API_DOMAIN`, a subdomain of the same domain so the Lax session cookie is sent.

## 1. Platform and deployment (apps on Vercel, API on a DigitalOcean Droplet)

- [x] **REQUIRED. Droplet stack written.** Done 2026-11-16: `infrastructure/deployment/droplet/` (Dockerfile, Compose with Caddy and
      a private clamd, cloud-init hardening, `deploy.sh`, README). Image built and Compose/Caddyfile validated locally; not yet run
      on a real Droplet. Still to do by you: follow the README's one-time setup (4 GB Droplet, same region as the database, DNS A
      record for `API_DOMAIN`), then record the first successful `deploy.sh` here.
- [ ] **REQUIRED.** Vercel project uses **Framework Preset: Services**, Root Directory empty, no Build/Install override. The
      deployment log must show two builds (`web`, `admin`). `NEXT_PUBLIC_API_URL=https://api.<domain>/api/v1` set for Production.
      See `infrastructure/deployment/README.md`.
- [ ] **REQUIRED.** Do **not** define `NODE_ENV` or `NPM_FLAGS=--production` as project variables (it breaks devDependency
      installs; reproduced 2026-11-13).
- [ ] **REQUIRED.** Node 22+ selected for the project (`engines` says `>=22`; local is Node 24).
- [ ] **REQUIRED.** Custom domain attached to Vercel, HTTPS enforced, HSTS enabled at the edge; Caddy on the Droplet obtains the
      API certificate itself and redirects HTTP (the API also sends HSTS in production). Decide whether to submit the domain to
      the HSTS preload list.
- [ ] **REQUIRED.** Schedulers: confirm in the API logs that unfilled-shift recovery runs on its in-process timer after the first
      deploy (`CRON_SECRET` stays unset; the `/scheduled` routes are only for an external scheduler).
- [ ] **REQUIRED.** Keep `MATCH_RETENTION_INTERVAL_HOURS=0` for the first deploy. Turn it on only after the procedure in
      `documentation/operations/match-retention-deployment.md` (a person watches the first deletions).
- [ ] **REQUIRED.** Vercel deployment protection: previews require Vercel authentication or a password. Previews cannot sign in
      against the production API (different site for the cookie); point them at a staging API or leave `NEXT_PUBLIC_API_URL` unset
      for the Preview environment. **Scope `NEXT_PUBLIC_API_URL` to Production.**
- [ ] **REQUIRED.** Migrations: the server applies them at start-up, so every `deploy.sh` that carries a migration is preceded by
      a backup (runbook §3) and run by a named person, not a hook.
- [ ] **REQUIRED.** Droplet in the same region as the database cluster; the Droplet is the cluster's only trusted source; Spaces
      bucket in the same region.
- [ ] **REQUIRED.** Droplet hardening from `cloud-init.yml` verified after first boot: `ufw status` shows only 22, 80, 443;
      `sshd -T | grep passwordauthentication` says no; `fail2ban-client status sshd` is active; port 3310 is closed from outside.
- [ ] **RECOMMENDED.** Turn on Vercel Web Application Firewall / attack challenge mode for the apps. Consider DigitalOcean's
      Cloud Firewall in front of the Droplet as a second layer to ufw (same three ports).

## 2. Data layer

- [ ] **REQUIRED.** Managed PostgreSQL with automated daily snapshots **and** point-in-time recovery, encrypted at rest, 14+
      days retained, copies in a second region or account (runbook §3).
- [ ] **REQUIRED.** **Restore drill performed on real PostgreSQL** and recorded (date, duration, result). Today restore has only
      been validated on the embedded PGlite. The drill: `pg_restore` into an empty database, run `migrate` (expect "No pending
      migrations"), hit `/ready`, sign in as a known user, confirm `UPDATE audit_logs` is still blocked by the trigger, compare
      row counts.
- [ ] **REQUIRED.** All 18 migrations applied on a staging copy with production-like data **before** production. Migration
      0017 takes SHARE ROW EXCLUSIVE locks on `match_runs` and `candidate_matches`; run it in a quiet window or pre-build the
      indexes `CONCURRENTLY` as its deployment doc describes.
- [ ] **REQUIRED.** Database roles: the runtime connects as a non-superuser role with only the grants it needs; migrations use
      a separate owner role. This is also the prerequisite for row-level security (ADR 0004).
- [ ] **REQUIRED.** Object-storage bucket versioning and replication on, lifecycle rules reviewed, and a documented procedure
      for restoring the bucket **together with** the database (a database restore without the matching files leaves documents missing).
- [ ] **RECOMMENDED.** Row-level security per ADR 0004 (`bsm_owner` / `bsm_app` / `bsm_platform` roles, request-scoped
      `SET LOCAL app.*`, policies on tenant tables, tests run as `bsm_app`). Listed as a pre-pilot task in the security baseline.
- [ ] **RECOMMENDED.** Connection limits and slow-query logging turned on at the provider; alert on connection saturation.

## 3. Application security

Implemented and tested already (do not redo, but re-verify in staging): argon2id passwords, opaque HttpOnly `SameSite=Lax`
session cookie that is `Secure` in production, 7-day absolute / 12-hour idle session expiry, TOTP MFA required for all platform
roles, server-side RBAC and tenant checks, Origin check on state-changing requests, CORS allowlist, CSP `default-src 'none'` on
the API, zod validation everywhere, parameterized SQL, AES-256-GCM field encryption, append-only audit log, log redaction, Stripe
webhook signature verification over the raw body, timing-safe `CRON_SECRET` comparison.

Still to do:

- [x] **BLOCKER. Shared rate-limit store.** Done 2026-11-16: `UpstashRateLimitStore` in `backend/src/shared/rate-limit.ts`,
      required in production (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) unless `RATE_LIMIT_STORE=memory` on a single
      long-running server. A store outage fails open with an error log; account lockout is database-backed and unaffected. Still
      to do by you: create the Upstash database and set the two variables; alert on the "rate-limit store unavailable" log line.
- [~] **REQUIRED. Malware scanning.** Adapter done 2026-11-16: `ClamAvScanner` (`CLAMAV_HOST`, `CLAMAV_PORT`), tested against a
      protocol stub only. The Droplet stack runs clamd as a container on an internal network with `CLAMAV_HOST=clamav` preset.
      Still to do by you: upload the EICAR test file in staging and confirm it is rejected. Decide and document whether reviewers
      may open `not_scanned` files; today the UI labels them.
- [ ] **REQUIRED. Trust-proxy correctness.** `app.set('trust proxy', 1)` in production assumes exactly one proxy hop, which is
      Caddy on the Droplet. Confirm after the first deploy that the request log shows real client IPs, not `172.x` container
      addresses. Do not put another proxy (Cloudflare, a load balancer) in front without raising the hop count.
- [x] **REQUIRED. Key-rotation script.** Done 2026-11-16: `npm run rotate-keys -w backend` (dry run by default, `--apply` to
      write, repeatable). Procedure in runbook §8. Still to do by you: rehearse it once in staging.
- [ ] **REQUIRED. Dependency advisory in the production tree.** `npm audit --omit=dev` on 2026-11-16: `next@15.5.28` bundles a
      vulnerable `postcss` (1 high, 1 moderate: XSS via `</style>` and source-map file disclosure). The fix npm offers is
      `next@16.4.6` (breaking). Decide: upgrade to Next 16 (ASSUMPTIONS #3 says "say if Next 16 is required"), or document why
      the advisories do not apply (the app does not process untrusted CSS at runtime) and set a date to revisit. Dev tree also has
      2 critical in `vitest`/`tinypool`; not shipped, but fix in CI.
- [x] **REQUIRED. CI pipeline.** Done 2026-11-16: `.github/workflows/ci.yml` runs typecheck, tests per workspace, both builds,
      `npm audit --omit=dev --audit-level=high` and gitleaks on every PR and push to main. Still to do by you: push, confirm the first
      run is green, and make the two jobs required status checks on `main` in the repository settings.
- [ ] **REQUIRED. Secrets hygiene.** `backend/.env` exists locally and is git-ignored (verified: not tracked). Confirm no
      secrets in Vercel build logs, rotate anything that was ever pasted into a chat or ticket, and enable Vercel's sensitive env
      var mode so values cannot be read back from the dashboard.
- [ ] **REQUIRED. Stripe (if billing is on).** Follow `documentation/operations/subscription-billing-deployment.md` in order;
      restricted API key not the full secret key; webhook endpoint URL exact; the six listed events only; webhook secret set on
      the API only; `BILLING_SUBSCRIPTIONS_ENABLED=false` for the first production deploy.
- [ ] **REQUIRED. AI assistant (if `ANTHROPIC_API_KEY` is set).** Confirm with counsel that sending aggregate staffing figures
      to Anthropic is acceptable under your HIPAA/BAA determination (ASSUMPTIONS #48). Set a monthly spend limit in the Anthropic
      console; there is no per-organization cap in code (ASSUMPTIONS #50). Keep the key on the backend only.
- [ ] **RECOMMENDED.** Nonce-based CSP for the Next apps (today `script-src 'unsafe-inline'`, noted in both `next.config.mjs`).
- [ ] **RECOMMENDED.** Cookie hardening: add the `__Host-` prefix to `bsm_session` once everything is on one origin (requires
      `Secure`, `Path=/`, no `Domain`, all already true).
- [ ] **RECOMMENDED.** Offer MFA enforcement for facility owners/admins (today optional for non-platform users).
- [ ] **RECOMMENDED.** Independent penetration test and a security review of the two web apps (never done; security baseline
      says "required before real users").

## 4. Observability and operations

- [ ] **REQUIRED. Log shipping.** Vercel keeps function logs briefly. Send the pino JSON lines to a log store (Vercel Log
      Drain to Datadog, Axiom, Better Stack, or similar) with 30+ days retention. The logs contain user ids and request ids but no
      bodies or tokens; treat the store as containing personal data.
- [ ] **REQUIRED. Alerts with a named owner** (runbook §4 table): `/api/v1/ready` failing twice in a minute pages; 5xx > 1%
      over 5 min; p95 > 2 s over 10 min; 429 volume 5× baseline; `auth.login_failed` spike; any `"unhandled error"` log line
      opens a ticket; failed backup pages. Nothing is wired today.
- [ ] **REQUIRED. Uptime monitor** on `GET /api/v1/health`, `GET /api/v1/ready`, the web root and `/admin` from outside Vercel.
- [ ] **REQUIRED. Error tracking** (Sentry or similar) on the API and both apps, with PII scrubbing on and source maps uploaded
      privately.
- [ ] **REQUIRED. Metrics aggregation.** `/api/v1/admin/metrics` is per process and resets on every cold start; on serverless
      it is nearly useless. Rely on the log store or Vercel analytics for request metrics instead, and say so in the runbook.
- [ ] **REQUIRED. Incident response filled in** (runbook §5): on-call rota, escalation contacts, breach-notification counsel,
      status page or customer-comms template. All marked "not defined" today.
- [ ] **REQUIRED. First administrator** created with `npm run create-admin -w backend` against the production database, MFA
      enrolled immediately, `BSM_ADMIN_PASSWORD` unset afterwards. Never seed a default password.
- [ ] **REQUIRED. Scheduled-job verification** after deploy: trigger each `/api/v1/scheduled/*` route once by hand with the
      secret and confirm the lease in `scheduler_leases` is taken and released, then watch the first automatic run in the logs.
- [ ] **RECOMMENDED.** Load test the API at expected pilot traffic against staging (shared PostgreSQL pooler, cold starts).

## 5. Legal, privacy, compliance (decisions that gate real users)

All of these are open in `ASSUMPTIONS.md`; none can be closed by engineering. The counsel brief is in
`documentation/compliance/counsel-review-brief.md`.

- [ ] **BLOCKER.** HIPAA applicability determination and, if covered, BAAs with every vendor that touches data (database,
      object storage, email, log store, error tracker, Anthropic, Stripe is out of scope for PHI). (#9)
- [ ] **BLOCKER.** Worker classification and background-check rules for the launch states. (#9)
- [ ] **BLOCKER.** Privacy policy and terms of service published; consent captured at registration; state privacy laws
      (CCPA/CPRA and others) reviewed, including automated-decision rules for matching (#9, #11).
- [ ] **REQUIRED.** Data-retention periods for accounts, applications, credentials, decision snapshots and audit logs (#8).
      Only match runs have retention and erasure today (ADR 0009); a data-subject request for anything else has no process.
- [ ] **REQUIRED.** Credential-document access policy confirmed (default today: platform reviewers only; facilities see status). (#6)
- [ ] **REQUIRED.** Facility verification requirements (what documents, any external checks) before approvals start. (#7, #12)
- [ ] **REQUIRED.** Launch professions and states chosen and seeded (#4, #5).
- [ ] **REQUIRED.** Counsel sign-off on the 90-day match retention period and legal-hold wording (#62-65).
- [ ] **REQUIRED.** If billing is on: Stripe account eligibility for this business model, pricing, cancellation and dispute
      policy (#10, #67-77).

## 6. Pre-launch verification (do in staging, record results)

- [ ] A real person completes every Release 1 flow in a browser: facility registration, email verification (real email),
      invitation acceptance, professional onboarding with a document upload, job posting, application, shift offer, admin review
      with MFA, password reset. Nobody has done this yet (`README.md`).
- [ ] Keyboard-only, screen-reader (NVDA or VoiceOver) and real-phone checks on the main flows (ASSUMPTIONS #59: only emulated so far).
- [ ] Cross-tenant check in staging with two organizations: organization B gets 404 on organization A's resources.
- [ ] Signed document download link: works for the owner within 60 s, fails for another user, fails after expiry.
- [ ] Webhook replay: resend a Stripe event and confirm nothing changes twice; break the signing secret and confirm 400s.
- [ ] Rollback rehearsal: redeploy the previous build and confirm it runs against the newer (additive) schema.
- [ ] Cold-start latency of the API function measured and acceptable (argon2 and pg pool initialization happen per instance).

## 7. Go / no-go

Go only when every **BLOCKER** is done, every **REQUIRED** has an owner and a date or is done, and the legal items in §5 have
counsel's written answers. Record the decision, the build SHA, and who approved it in `CHANGELOG.md`.

### Quick reference: production environment variables

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | backend | Managed PostgreSQL, pooler endpoint, `sslmode=require` |
| `MFA_ENCRYPTION_KEY` | backend | 32 bytes base64; separate backup |
| `FIELD_ENCRYPTION_KEY` | backend | 32 bytes base64, different value; separate backup |
| `WEB_URL`, `ADMIN_URL` | backend | Public origins; feed CORS, Origin check, email links |
| `API_DOMAIN` | droplet `.env` | The API's hostname, a subdomain of the apps' domain; Caddy gets its certificate |
| `CRON_SECRET` | backend | Unset on the Droplet (in-process timers); only for an external scheduler |
| `SHIFT_RECOVERY_INTERVAL_MINUTES` | backend | Keep default 5 (schedule runs every 15) or 0 to disable |
| `MATCH_RETENTION_INTERVAL_HOURS` | backend | **0 on first deploy**; enable per the retention deployment doc |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY` or `POSTMARK_SERVER_TOKEN` | backend | Required; domain needs SPF, DKIM, DMARC |
| `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | backend | Required; private bucket, least-privilege key |
| `RATE_LIMIT_STORE=memory` | set by compose.yml | Correct for the single API container; switch to Upstash before a second instance |
| `CLAMAV_HOST`, `CLAMAV_PORT` | set by compose.yml | The `clamav` container; without a scanner uploads are stored `not_scanned` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_SUBSCRIPTIONS_ENABLED` | backend | Restricted key; billing off on first deploy |
| `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_EFFORT` | backend | Optional; spend cap in console |
| `LOG_LEVEL` | backend | `info` |
| `NEXT_PUBLIC_API_URL` | apps (Vercel, Production) | `https://api.<domain>/api/v1` |
| `NEXT_PUBLIC_BASE_PATH` | apps | Leave unset on Vercel (defaults to `/admin`) |
| `NODE_ENV` | compose.yml only | Set to `production` for the API container; never define it on Vercel (breaks installs) |
