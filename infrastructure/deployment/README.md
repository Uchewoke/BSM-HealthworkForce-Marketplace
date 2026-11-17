# deployment

Two targets (decided 2026-11-16):

- **The apps on Vercel**, one project with two services (`vercel.json` at the repository root): the public site and portal
  (`web`, at `/`) and the staff app (`admin`, at `/admin`). Vercel builds each from its own folder and routes requests by the
  top-level `rewrites`; the admin app is built with `basePath: /admin`.
- **The API on a DigitalOcean Droplet** as one long-running container behind Caddy, with a private clamd beside it:
  `droplet/` (Dockerfile, Compose file, cloud-init, deploy script, README with the step-by-step setup). PostgreSQL on Neon
  (free plan, decided 2026-11-17 to save cost) and a DigitalOcean Space hold the data; the Droplet holds none.

The browser calls the API cross-origin at `NEXT_PUBLIC_API_URL` (for example `https://api.example.com/api/v1`), with credentials.
The API allows exactly `WEB_URL` and `ADMIN_URL` (CORS and the Origin check) and its session cookie is `SameSite=Lax`, which
browsers send between `app.example.com` and `api.example.com` (same site). Keep the API on a subdomain of the apps' domain.

`backend/src/serverless.ts` remains the entry point for running the API on Vercel instead (restore the `backend` service, the
`/api` rewrite and the two `schedules` in `vercel.json` from the git history); that path needs Upstash and cannot reach a private clamd.

## Project settings on Vercel

- **Framework Preset: Services.** The dashboard must show two builds (`web`, `admin`). If a deployment runs one
  `npm run build` at the repository root instead (the log then shows `workspace @bsm/web` lines), the project is not in services
  mode: set the Framework Preset to Services, leave Root Directory empty and remove any Build or Install Command override.
- **Do not define `NODE_ENV` yourself** (nor `NPM_FLAGS=--production`). Vercel provides `NODE_ENV=production` at runtime on its
  own. A `NODE_ENV` project variable also applies while dependencies install, and npm then skips `devDependencies`: TypeScript is
  missing, Next ignores `tsconfig.json`, and every `@/...` import fails with "Module not found" (reproduced on 2026-11-13). Each
  service in `vercel.json` therefore installs with `npm install --include=dev --workspaces --include-workspace-root`, which installs the whole workspace (root devDependencies included) from the
  repository root regardless of that variable.
- Node.js 22 or newer (`engines` in `package.json`).

## Status: deployable once the production providers are configured

`backend/src/runtime.ts` refuses to start with `NODE_ENV=production` until an email provider (`EMAIL_PROVIDER=resend|postmark`,
`EMAIL_FROM`, the provider key) and a private S3-compatible bucket (`STORAGE_BUCKET` and friends) are set, and names each missing
variable in the error. The Compose file sets `RATE_LIMIT_STORE=memory` (one process on one server) and `CLAMAV_HOST=clamav`.
See `.env.example` for every variable and `droplet/env.example` for the values the Droplet needs. The Dockerfile and Compose file
have been built and validated locally; the stack has not yet been run against real DigitalOcean resources.

## Environment variables

API (`droplet/.env` on the Droplet, from `droplet/env.example`): `API_DOMAIN`, `DATABASE_URL` (Neon's pooled connection string with
`sslmode=require`; for DigitalOcean Managed PostgreSQL see `droplet/env.example`), `MFA_ENCRYPTION_KEY`,
`FIELD_ENCRYPTION_KEY`, `WEB_URL` and `ADMIN_URL` (the Vercel origin, e.g. `https://app.example.com` and `https://app.example.com/admin`),
the email and storage settings above, plus the optional providers (Stripe, Anthropic). No `CRON_SECRET` is needed: the timers run in-process.

Apps (project settings on Vercel): `NEXT_PUBLIC_API_URL=https://api.example.com/api/v1` for the Production environment. The admin
app's base path defaults to `/admin` on Vercel. Preview deployments are a different site from the API's cookie point of view and
cannot sign in against the production API; give them a staging API (own Droplet, own `WEB_URL`) or leave `NEXT_PUBLIC_API_URL` unset for previews.
Do not define `NODE_ENV` on Vercel (see above).

## Migrations

The long-running server applies pending migrations when it starts (`backend/src/server.ts`), so a deploy with `droplet/deploy.sh`
migrates before the new container reports healthy. Take a backup first (runbook §3); migrations are forward-only.

## Scheduled work

The server runs unfilled-shift recovery (`SHIFT_RECOVERY_INTERVAL_MINUTES`, default 5) and match-run retention
(`MATCH_RETENTION_INTERVAL_HOURS`) on in-process timers, under a database lease. Keep retention at `0` until a person has watched
the first run, as `documentation/operations/match-retention-deployment.md` requires. The secret-protected `/api/v1/scheduled/*`
routes exist for an external scheduler and stay unused (`CRON_SECRET` unset) on the Droplet.

## Local development

Unchanged: `npm run dev -w backend`, `npm run dev -w @bsm/web`, `npm run dev -w @bsm/admin` on ports 4000/3000/3001, calling the API
cross-origin, exactly as production does. The API image can be built and run locally too:
`docker build -f infrastructure/deployment/droplet/Dockerfile -t bsm-api .` then `docker run --rm -p 4000:4000 --env-file backend/.env -e NODE_ENV=development bsm-api`.
