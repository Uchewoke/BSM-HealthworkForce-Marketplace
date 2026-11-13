# deployment

The repository deploys to Vercel as **one project with three services** (`vercel.json` at the repository root): the public site
and portal (`web`, at `/`), the staff app (`admin`, at `/admin`) and the API (`backend`, at `/api`). One domain, one deployment,
one set of environment variables. Vercel builds each service from its own folder and routes every public request by the
top-level `rewrites`; the service receives the original path, which is why the API's routes stay at `/api/v1/...` and the admin
app is built with `basePath: /admin`.

Nothing calls another service server-side (both apps are client-rendered and the browser calls `/api/v1` on the same origin),
so no service bindings are declared. Add one only if server-side code in a service starts calling another.

## Status: not deployable to production yet

`backend/src/runtime.ts` refuses to start with `NODE_ENV=production` because no email adapter and no private object-storage
adapter exist (see `../storage/README.md`). Vercel sets `NODE_ENV=production` for every deployment, previews included, so the API
function fails until those adapters are implemented. The configuration here is complete up to that point; it has been verified
with typecheck, tests and local builds, not with a deployment.

## Environment variables (project settings on Vercel)

Backend (also see `.env.example`): `DATABASE_URL` (PostgreSQL; required, there is no disk for the embedded database),
`MFA_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY`, `WEB_URL` and `ADMIN_URL` (the public origin, e.g. `https://app.example.com` and
`https://app.example.com/admin`; they feed email links and the allowed origins), `CRON_SECRET` (random, 16+ characters; Vercel
sends it with every scheduled request), plus the optional providers. The deployment's own `VERCEL_URL`, `VERCEL_BRANCH_URL` and
`VERCEL_PROJECT_PRODUCTION_URL` are allowed origins automatically so previews can sign in.

Apps: nothing is required. `NEXT_PUBLIC_API_URL` defaults to `/api/v1` on Vercel and the admin app's base path to `/admin`; set
`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_BASE_PATH` only to override.

## Migrations

The serverless entry (`backend/src/serverless.ts`) never applies migrations: several functions starting at once would race on the
schema. Apply them as a deploy step, before the new build goes live, as the runbook says: `npm run migrate -w backend` with the
production `DATABASE_URL`.

## Scheduled work

The long-running server runs unfilled-shift recovery and match-run retention on timers. On Vercel a function cannot keep a timer,
so `vercel.json` declares two Vercel Schedules that call secret-protected routes instead: `POST /api/v1/scheduled/shift-recovery`
(every 15 minutes; Pro plans may use 5, matching the in-process default) and `POST /api/v1/scheduled/match-retention` (daily,
03:00 UTC). Both take the same database lease as the timers, so a scheduler and a long-running server can coexist, and both are
off when `SHIFT_RECOVERY_INTERVAL_MINUTES=0` / `MATCH_RETENTION_INTERVAL_HOURS=0`. Keep retention off until a person has watched
the first run, as `documentation/operations/match-retention-deployment.md` requires.

## Local development

Unchanged: `npm run dev -w backend`, `npm run dev -w @bsm/web`, `npm run dev -w @bsm/admin` on ports 4000/3000/3001, calling the API
cross-origin. `vercel dev` runs the three services together behind one port with the production routing (`/admin`, `/api`).
