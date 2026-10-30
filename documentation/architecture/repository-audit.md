# Repository Audit (Milestone 0)

Date: 2026-10-30

## Current state
- Only planning documents (`01`–`08`, `README.md`) existed. No code, manifests, DB, auth, tests or deployment config.
- Greenfield build. Nothing to preserve or migrate.
- The folder was inside a git repo rooted at the user's home directory; a dedicated repo was initialised here (`git init -b main`).

## Toolchain discovered
- Node v24.14.0, npm 11.17.0, Docker 29.8.0 CLI (daemon was not responding at audit time), no local `psql`.

## Reference projects (not part of this repo)
- `Desktop/bsm workforce`: Next 15.5, Drizzle ORM, pg, zod 4, jose, bcryptjs, RLS SQL, audit helper. Patterns may inform auth/audit/tenant isolation.
- `Desktop/BSM DIGITAL WORKFORCE`: Next 15, Supabase, Stripe, Resend.

## Target stack (approved defaults)
- npm workspaces monorepo, TypeScript strict.
- `apps/web` and `apps/admin`: Next.js 15 + React 19 (admin stays on 15 unless the owner asks for 16).
- `backend`: Express + TypeScript, modular monolith, `/api/v1`.
- PostgreSQL (Docker locally) + Drizzle ORM + SQL migrations; row-level security as defence in depth.
- Auth in backend: argon2 password hashes, server-side sessions in Postgres, TOTP MFA for platform roles.
- Adapters (email, storage, verification, payments) behind interfaces; manual/pending fallbacks, never simulated success.

## Missing for Release 1
Workspace tooling, DB + migrations, auth/sessions, RBAC + tenant isolation, validation/error/logging/audit foundations, private storage adapter, job queue, notifications, test harness, CI, all domain modules and UIs.

## Risks
| Risk | Mitigation |
|---|---|
| Tenant data leakage (IDOR/BOLA) | Membership checks in services, RLS, cross-tenant tests |
| Credential documents exposure | Private storage, signed short-lived URLs, access logging |
| Faked verification | Status enum separates submitted/pending/verified; verified only via admin review with recorded source |
| Legal status of "technology marketplace" | Counsel review; see ASSUMPTIONS.md |
| Nationwide multi-state licensing | State rules in configuration tables, not code |
| Docker daemon unavailable locally | Start Docker Desktop, or provide DATABASE_URL to any Postgres 16 |

## Sequence
M1 foundations → M2 facility onboarding → M3 professional onboarding → M4 jobs/shifts → M5 applications/eligibility → M6 hardening. Agency domain modelled early; UI later.
