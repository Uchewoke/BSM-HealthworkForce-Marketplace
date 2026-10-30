# ADR 0001: SQL migrations with a thin query layer; PGlite for dev/tests

Status: accepted (2026-10-30)

## Decision
- Schema changes are plain SQL files in `backend/migrations/NNNN_name.sql`, applied in order by `migrate()` and tracked in `schema_migrations`.
- Data access goes through a small `Db`/`Queryable` interface with two implementations: `pg` (runtime) and PGlite (embedded Postgres, tests and zero-dependency local dev).
- Authentication is built in the Express backend: argon2id, server-side sessions (opaque cookie token, SHA-256 stored), TOTP MFA with encrypted secrets and replay protection.

## Why
Drizzle was the earlier default, but it would duplicate the schema in TypeScript and SQL. Plain SQL keeps one source of truth, runs identically on PGlite and Postgres, and Docker is not required for tests.

## Consequences / follow-ups
- Row-level security is NOT yet implemented. Tenant isolation currently relies on service/middleware checks plus tests. RLS needs a per-request DB role/session variable; planned for Milestone 6 hardening.
- Rate limiting is in-memory (single process). Use a shared store before running multiple instances.
- No production email adapter exists; the server refuses to start in production until one is implemented.
- Query results are loosely typed; revisit a typed query builder if the schema grows painful.
