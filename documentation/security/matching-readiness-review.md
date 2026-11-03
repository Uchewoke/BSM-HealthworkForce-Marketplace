# Matching engine: production-readiness review

Date: 2026-11-02. Scope: commit `13dcaaf` (advisory match runs, batch evaluator) plus the corrective changes below. Eligibility rules, ranking factors and weights were not changed.

## Recommendation

**Conditionally ready for a controlled pilot; not ready for general production.** The two verified defects are fixed and tested. Before a pilot, close the three open items marked **Pilot gate** below (retention, a real-PostgreSQL migration rehearsal, counsel review of the ranking factors). Nothing found blocks an internal or invite-only pilot with those in hand.

## Checks performed

| # | Check | Result |
|---|---|---|
| 1 | Diff of `13dcaaf` (16 files, +778/-58) read in full | Done. Two defects found (below) |
| 2 | `AGENTS.md`, ADR 0003/0005/0008, assumptions, security baseline read | Done. Two documentation claims were wrong (below) |
| 3 | Tests | Backend **410/410**, UI 30/30, other workspaces 7, 6, 9 passing. Matching module: `matching.test.ts`, `applications.test.ts`, `talent.test.ts`, `match-runs.test.ts` (17) all pass. `npm run typecheck`: no errors in 4 workspaces |
| 4 | Migration 0016 on PGlite (real Postgres engine) over a database already holding legacy `candidate_matches` rows | Passes: applies, legacy rows keep working, legacy-style `apply/offer/accept` inserts still accepted, updates blocked, deletes (cascades) still allowed |
| 5 | Organization scoping and authorization on every new query | Confirmed (details below) |
| 6 | Eligibility recheck at apply, invitation, offer, acceptance | Apply, offer, acceptance: **yes**. Invitation: **no** (by existing design) |
| 7 | Anonymous talent exposure | Confirmed after fix (details below) |
| 8 | Rate limits, caps, audit, retention | See risks |
| 9 | N+1 queries | Confirmed batched; regression test added |
| 10 | Tie-breaking and explainability | Confirmed |
| 11 | Model receives personal data | Confirmed it does not |
| 12 | Fair hiring, credential data, stale results, access control | See risks |

Commands: `npx vitest run tests/match-runs.test.ts` (red then green), `npx tsc -p .` in `backend` and `apps/web`, `npm run typecheck`, `npm test`, and a throwaway script that migrated PGlite to 0015, inserted a legacy row and applied the real `0016_match_runs.sql` (script removed).

## Corrective changes (verified defects only)

1. **Pay expectation leaked to facilities (High).** The compensation factor's note, value and contribution embedded or revealed the professional's minimum hourly rate (the note literally contained it). ADR 0005 says a facility never sees a pay expectation. It was exposed for anonymous talent in the new run results, and for applicants in both run results and the pre-existing application detail (`ranking`). Reproduced with a failing test first (an hourly job; the string `4800` appeared in the response). Fix: `facilityView()` in `matching/ranking.ts` withholds that one factor's value, contribution and note for all facility-facing output (`matching/service.ts`, `applications/routes.ts`). Scores, ordering, weights and the stored explanation are unchanged. UI handles the withheld factor.
2. **Anonymous talent visible beyond talent-search permission (Medium).** Reading a run needs only `applications.read`, so a read-only member (or any member after the organization stopped being approved) could see anonymized talent cards they cannot search for. Fix: talent rows in a stored run are returned only if the member has `professionals.search` and the organization is approved. Tested for read-only and for a non-approved organization.
3. **Documentation and UI claimed eligibility is rechecked at invitation (Medium, accuracy).** The invitation endpoint never evaluates eligibility; the gate is at apply, offer and acceptance. Corrected in the matching page, API note, route comment, ADR 0008, changelog, inspection report and a test name.

## Confirmed protections

- **Scoping:** every query in `matching/service.ts` filters by `organization_id` (job, applications, runs, results); the route takes the organization from the membership check, never the request. Composite foreign keys tie runs and results to the same organization as the job. Tests cover another organization's run id, job id and non-members (all 404).
- **Authorization:** create needs `professionals.search` plus an approved organization; list and read need `applications.read`; agency roles hold neither search nor job ownership.
- **Eligibility recheck:** apply (hard failures refused), agency submission, offer and acceptance (inside the transaction, refusals recorded), shift offers, float pool create and accept. A run itself creates no application, invitation or offer (tested).
- **Anonymity:** talent results contain a per-organization `talentRef` and a card (profession, specialties, city, state, years). Tests assert the raw JSON contains no name, email, phone, headline text, employer, school, credential number, credential id or professional id, and now no pay expectation. Opted-out people are hidden when a run is read.
- **Audit:** `match.run` and `match.run_viewed` record counts and versions only (tested: no names or emails).
- **Batching:** loading is one query per table for any number of candidates (test: same query count for 1 and for all candidates, at most 14).
- **Determinism:** order is outcome group, then score, then a stable tie-break (application time and id, or professional id). Seven factors each return weight, value, contribution and a plain-language note.
- **No model sees personal data:** no file in `matching/`, `talent/` or `applications/` imports the assistant or any AI provider; the assistant's tools return aggregates only.

## Risks

**Critical:** none found.

**High**
- None open after fix 1. Residual: the total score still includes the withheld factor, so a facility that knows every other factor could bound the compensation contribution. Low practical risk; the product owner may prefer showing rank only for anonymous talent.

**Medium**
- **No retention or erasure policy for run results (Pilot gate; addressed afterwards by ADR 0009: configurable retention, legal hold and matching-data erasure. Decision snapshots, applications and account erasure remain open).** Results hold personal data (eligibility details, names via applications) indefinitely; each run can store up to 800 rows and 20 runs per hour are allowed per user. `candidate_matches` has no link to professionals, so an erasure process must delete by `professional_id`. There is no account-deletion path yet. ASSUMPTIONS #60, #8.
- **Migration not rehearsed on real PostgreSQL (Pilot gate).** PGlite is a real Postgres engine and the upgrade path passed, but production uses `pg` against a hosted server. Rehearse on a copy of production data first. The migration drops `candidate_matches_trigger_check` by name; if production's constraint was created under another name, the old check would silently remain and block `recommend` rows.
- **Ranking factors need fair-hiring review (Pilot gate).** Years of experience can proxy for age; recency of work history penalizes career gaps (caregiving, illness, military service); profile completeness and pay compatibility are not clearly job-related. Weights are an unvalidated proposal (ASSUMPTIONS #24).
- **Invitations do not check eligibility.** An ineligible person can be invited and is refused only when they apply. The UI hides the button for ineligible candidates but the server does not enforce it. Recommended: refuse hard failures (ineligible, expired, unavailable) at invitation, mirroring the apply gate. Not changed because it alters an existing flow.
- **Remaining N+1 callers.** Float pool, exchange and shift recovery still evaluate one candidate at a time (up to 100 per shift). Bounded, but the same batching applies.

**Low**
- Stale results: a run is a snapshot with a timestamp; there is no staleness badge. Credentials expiring after a run are only caught at apply, offer or acceptance.
- Rate limiting is in process memory: with several API servers each has its own counter. Reads are not rate limited beyond the global limit, and each view writes an audit row.
- Reading a talent run creates `talent_refs` rows on first sight (a write on GET) and does one insert per displayed talent row.
- No skills model and no distance matching; ordering ignores both (ASSUMPTIONS #61).

## Open follow-ups
Decide retention (and an erasure routine), rehearse the migration on production data, get domain and counsel review of the ranking factors, and decide whether invitations should enforce the apply gate.
