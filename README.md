# BSM HealthForce Marketplace

A three-sided healthcare workforce marketplace (facilities, independent professionals, and, in a later release, staffing agencies). BSM provides the software; it is not an employer or a staffing agency. See `01-business-model.md` … `08-decisions-log.md` for the product background and `ASSUMPTIONS.md` for open product and legal decisions.

> **Status:** Release 1 is implemented end to end in the API and in two web apps, but it has **not been run in a real browser by a person, has not had a security review, and is not ready for real users.** Read "What is not done" below before using it with anyone.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Express + TypeScript API (`/api/v1`), SQL migrations, 255 tests |
| `apps/web/` | Next.js 15 app for facilities and professionals (port 3000) |
| `apps/admin/` | Next.js 15 app for BSM staff (port 3001) |
| `packages/api-client/` | Typed fetch client used by both apps |
| `packages/ui/` | Shared accessible components, honest status displays, time-zone helpers |
| `packages/permissions/` | Role/permission rules shared by the API and the apps |
| `documentation/` | Architecture decisions (ADRs), security baseline, operations runbook, API index, acceptance matrix |

## Quick start (Windows, macOS, Linux)

Prerequisites: Node 22 or newer. No database server is needed for development; the API uses an embedded PostgreSQL (PGlite) stored in `backend/.data`.

```bash
npm install                      # installs every workspace (the first install is slow)
cp .env.example backend/.env     # then set the two keys below
# generate each key with:  openssl rand -base64 32
#   MFA_ENCRYPTION_KEY=...   FIELD_ENCRYPTION_KEY=...   (different values)
npm run migrate -w backend       # applies migrations
npm run dev -w backend           # API on http://localhost:4000
npm run dev -w @bsm/web          # web app on http://localhost:3000   (new terminal)
npm run dev -w @bsm/admin        # admin app on http://localhost:3001 (new terminal)
```

In development, verification and password-reset links are **printed in the API terminal** (`[DEV EMAIL - not delivered]`); nothing is emailed.

Create the first staff account (never seed a default password), then sign in at http://localhost:3001 and enroll MFA:

```bash
BSM_ADMIN_PASSWORD='<12+ chars>' npm run create-admin -w backend -- you@example.com "Your Name" platform_super_admin
```

(Stop the API first: the embedded database allows one process at a time.)

The apps read `NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api/v1`).

## Checks

```bash
npm run typecheck        # all workspaces
npm test                 # backend 256, UI 28, client 7, permissions 6 (run per workspace if the root command stalls on Windows)
npm run build -w @bsm/web && npm run build -w @bsm/admin
```

## What is not done

- **No manual or browser testing.** The UI is covered by component tests (with automated accessibility checks), type checks and production builds, and was smoke-tested against the live API with scripted requests. Nobody has clicked through it in a browser. Keyboard, screen-reader and mobile checks are still to do.
- **Production blockers:** no email provider, private object-storage adapter or malware scanner (the API refuses to start in production without them); in-memory rate limiting; no row-level security (ADR 0004); backup/restore never run on real PostgreSQL; no alerting; no penetration test.
- **Legal and policy decisions** are open: see `ASSUMPTIONS.md` (HIPAA applicability, state privacy law, worker classification, background checks, retention, pay-transparency rules, launch professions and states, UI wording).
- **Not built:** agency marketplace (Release 2), offers/assignments/timesheets/invoices/payments (Release 3), an OpenAPI document (see `documentation/api/endpoints.md`).

See `CHANGELOG.md` for what changed in each milestone and `documentation/` for the details.
