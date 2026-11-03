# ADR 0008: Advisory candidate matching runs

Status: accepted (2026-11-02). Builds on ADR 0003 (eligibility and ranking) and ADR 0005 (talent search privacy).

## Context
Eligibility and ranking already existed and were used when someone applied, when reviewing applicants, in talent search and in offers. What was missing: a way to ask "who fits this job?" before anyone applies, and a stored record of what a facility was shown.

## Decision
A **match run** evaluates candidates for one job and stores the result. It reuses the existing engine without changing it:
1. Eligibility (`eligibility-v1`) decides first. Only `eligible` candidates are ranked (`ranking-v1`, configurable weights). Everyone else is listed with every reason.
2. A run is **advisory**. It creates no application, invitation, offer or status change. People act through the existing invitation, review, offer and acceptance flows. Eligibility is enforced when someone applies and at every offer and acceptance (ADR 0003); an invitation itself does not check it, so an invited person who is not eligible is refused when they apply.
3. No language model is used to score, rank or explain. Explanations are the engine's own reasons and factor notes. Credential verification stays with platform reviewers.
4. Scope is `applicants`, `talent` or `both`. Talent follows ADR 0005: opted-in and active only, shown as a per-organization `talentRef` and an anonymized card, never identity. Anyone who opts out after a run is hidden when it is read.
5. Results are stored in `candidate_matches` (with a `recommend` trigger and a `run_id`) and runs in `match_runs`, with the rules, ranking and weights versions. Creating and viewing a run are audited (counts and versions only, no personal data). Both tables reject updates.

## Performance
`evaluateMatches` batches the loading (one query per table for all candidates) and runs the same pure rules. The single-candidate `evaluateMatch` calls it, so there is one code path. Runs are capped at 500 applicants and 300 talent and rate limited to 20 per user per hour.

## Not done, and why
- **Skills** and **distance**: no data model or geocoding decision exists (ASSUMPTIONS #61).
- **A "shift coverage" ranking factor**: it would be constant for ranked candidates, because availability is an eligibility rule.
- **A model-written summary**: would send personal data to a provider that has not had privacy review (ASSUMPTIONS #48, #60).

## Known limits
Results are a point-in-time snapshot. Run results now expire under the retention policy in ADR 0009. Weights and rules still need domain and legal review (ASSUMPTIONS #24).
