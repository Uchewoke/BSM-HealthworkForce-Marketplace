# ADR 0004: Row-level security is deferred (not implemented)

Status: accepted (2026-10-30). Supersedes the "planned for Milestone 6" note in ADR 0001.

## Context
Tenant isolation is currently enforced in application code (session-derived membership checks, queries scoped by `organization_id`) and in the
database by composite foreign keys that make cross-tenant links impossible. PostgreSQL row-level security (RLS) would add a second line of defence
against a missed `WHERE` clause.

## Why it was not built now
- RLS only protects if the application connects as a **non-superuser, non-owner role** and every request sets its identity (e.g. `SET LOCAL app.user_id`, `app.org_ids`, `app.platform`) inside a transaction. Today every query goes through a shared pool without per-request transactions, so adding policies would either do nothing (superuser bypass) or break many cross-tenant but legitimate reads (marketplace job search, candidate evaluation, platform administration, notifications to other organizations' staff).
- The embedded PGlite used in tests runs as a superuser and cannot validate a real role/grant setup. Shipping policies that were never run against real PostgreSQL would look like protection without being any.

## Decision
Do not ship partial or unverified RLS. Record the design and make it a pre-pilot task, to be developed and tested against a real PostgreSQL instance.

## Planned design
1. Roles: `bsm_owner` (migrations), `bsm_app` (runtime, no BYPASSRLS), `bsm_platform` (platform/admin and system jobs, bypass via explicit policies).
2. A request-scoped transaction wrapper sets `app.user_id`, `app.org_ids` (active memberships) and `app.is_platform`.
3. Policies first on `jobs`, `applications`, `application_*`, `candidate_matches`, `facilities`, `facility_locations`, `departments`, `organization_*`, `credentials` / `credential_documents` (owner or reviewer), `notifications`, `support_tickets`.
4. Tests that run as `bsm_app` and prove a query without the scoping predicate still returns nothing across tenants.
5. Keep the existing application-level checks; RLS is the backstop, not the primary control.

## Consequences
The security baseline lists this as a known gap. A missed tenant predicate in new code would currently be caught only by tests and review; the cross-tenant tests in `tenant-isolation.test.ts`, `onboarding.test.ts`, `jobs.test.ts`, `applications.test.ts`, `professional.test.ts` and `e2e-release1.test.ts` exist to reduce that risk.
