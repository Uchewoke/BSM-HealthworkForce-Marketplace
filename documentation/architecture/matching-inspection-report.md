# Matching engine: repository inspection report

Date: 2026-11-02. Written before any matching code was changed. Implementation status is in the last section; decisions are in ADR 0008.

## 1. Existing architecture

**Stack:** npm workspaces monorepo. Express 5 + TypeScript modular monolith in `backend/`; Next.js 15 apps `apps/web` (facility, agency and professional portals) and `apps/admin`; shared `packages/permissions`, `packages/ui`, `packages/api-client`. Tests: Vitest + supertest on PGlite. Rules for contributors: `AGENTS.md`.

**Data layer:** raw SQL migrations (`backend/migrations/0001…`) applied by `migrate()` through `pg` (production) or PGlite (tests). There is **no Prisma** in the repository. ASSUMPTIONS #1 mentions Drizzle, which is not used either.

| Concern | Where |
|---|---|
| Facility portal routes | `apps/web/app/facility/[orgId]/…` (jobs, candidates, talent, applications, recovery, exchange) |
| Professional registration and profile | `backend/src/modules/professionals/`, `apps/web/app/professional/{profile,availability,credentials}` |
| Authentication and authorization | Server-side sessions (`modules/auth`); `requireOrgPermission` (404 for non-members, 403 for a missing permission); roles in `packages/permissions`; platform roles require MFA |
| Audit | `audit()` into append-only `audit_logs` |

**Relevant models:** `professionals`, `professional_specialties`, `professional_experience`, `professional_education`, `professional_preferences`, `professional_availability`, `credentials` (+ `credential_verifications`), `jobs`, `job_requirements` (mandatory flag), `shifts`, `facility_locations`, `applications`, `application_events`, `candidate_matches`, `talent_invitations`, `talent_refs`, `shift_offers`, `assignments`.

**Existing matching (`backend/src/modules/matching/`):**
- Stage 1, `eligibility.ts`: pure, versioned (`eligibility-v1`). Profession, account status, mandatory licenses and certifications, specialty, minimum experience, weekly availability in the facility time zone, shift conflicts. Returns an outcome and every reason.
- Stage 2, `ranking.ts`: seven weighted factors (`ranking-v1`), run only for eligible candidates; weights are admin-configurable in `platform_settings`.
- `loader.ts`: loads data, runs both stages, writes `candidate_matches` snapshots at apply, offer and accept.
- Used by: applying (including agency submissions), the candidate list and applicant detail, talent search with `jobId`, offers and acceptance (hard eligibility gate), float pool, shift recovery, and the exchange.
- No AI is involved. The assistant is read-only and told never to judge eligibility.

## 2. Gaps found

1. No skills model.
2. Location is state-level only; `max_travel_miles` is collected but unused; no coordinates.
3. No proactive shortlist before anyone applies (talent search is anonymized, opt-in only, capped at 300).
4. `candidate_matches.application_id` was `NOT NULL`, so results without an application could not be stored.
5. About 10 sequential queries per candidate (up to 300 for talent search, 500 for the candidate list).
6. The candidate list wrote no audit entry.

## 3. Design

- Keep scoring deterministic; no language model in the scoring path (privacy review of third-party data flow is open: ASSUMPTIONS #48, #49).
- Eligibility first, ranking second, unchanged. A score never moves anyone past a mandatory requirement.
- Advisory "match runs" over applicants, opted-in talent, or both. A run creates no application, invitation or offer; people act through the existing flows (eligibility is enforced at apply, offer and acceptance, not at invitation).
- Reuse `candidate_matches` rather than a parallel results table; add `match_runs` for run metadata.
- Talent stays anonymous (ADR 0005).

## 4. Files to modify

`matching/loader.ts` (batch evaluator), `professionals/service.ts` (batch completeness), `applications/routes.ts` (batch + audit), `talent/routes.ts` (batch), `organizations/routes.ts` (mount), the facility job page (link), `documentation/api/endpoints.md`, `documentation/database/coverage.md`, `CHANGELOG.md`, `ASSUMPTIONS.md`. No permission changes were needed. The API client is generic and needed none.

## 5. New files

`backend/migrations/0016_match_runs.sql`, `matching/service.ts`, `matching/routes.ts`, `backend/tests/match-runs.test.ts`, `apps/web/app/facility/[orgId]/jobs/[jobId]/matching/page.tsx`, `documentation/decisions/0008-match-runs.md`.

## 6. Algorithm

1. Candidate pool: open applicants for the job; for talent, discoverable and active professionals of the job's profession who have not applied and are not organization members.
2. Eligibility (`evaluateEligibility`) gives the outcome and all reasons.
3. Rank eligible candidates only (`rankCandidate`, seven factors, each with weight, value, contribution and note).
4. Order by outcome group, then score, then a deterministic tie-break.

## 7. API

All under `/api/v1/organizations/:orgId`.

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /jobs/:jobId/match-runs` `{scope, shiftIds?}` | `professionals.search` + approved org | 20 per user per hour; job must be published or paused |
| `GET /jobs/:jobId/match-runs` | `applications.read` | run history |
| `GET /match-runs/:runId?group&page&pageSize` | `applications.read` | applicants by name; talent by `talentRef` only; viewing is audited |

There is deliberately no accept/reject-by-score endpoint. Inviting uses the existing invitation endpoint.

## 8. Database changes

Needed only to store runs: `match_runs`; `candidate_matches` gains `run_id`, `source`, `rank`, a `recommend` trigger and an optional `application_id`; both tables reject updates (migration 0016).

## 9. Phased plan

1. Batch evaluator and audit on candidate review (behavior-preserving).
2. Migration and run endpoints for applicants.
3. Talent scope and privacy tests.
4. UI, documentation, assumptions.
5. Deferred pending decisions: skills, distance, optional model summary.

## 10. Risks

- **Privacy:** re-identification of anonymized talent by combining fields or repeated runs (mitigated by `talentRef`-only output, caps, rate limits, audit). Run results hold personal data and have no retention period yet (ASSUMPTIONS #60).
- **Security:** every new query must filter by `organization_id`; row-level security is still deferred (ADR 0004).
- **Staleness:** eligibility changes (credentials expire); results are a snapshot; apply, offer and acceptance re-check.
- **Legal:** automated-decision and fair-hiring rules, and unvalidated weights (ASSUMPTIONS #9, #24), still need counsel.
- **Performance:** runs are capped (500 applicants, 300 talent) and rate limited; move to a worker only if needed.
- **Model option:** sending personal data to a provider, and prompt injection from user-written text.

## 11. Implementation status (2026-11-02)

Phases 1 to 4 are implemented and committed (`13dcaaf`). Ranking was not changed: a "shift coverage" factor was rejected because anyone unavailable for the requested shifts is already ineligible. Open: skills, distance, retention of run results, and whether a model-written summary is wanted (ASSUMPTIONS #60, #61).
