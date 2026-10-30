# ADR 0003: Eligibility, ranking, applications and notifications

Status: accepted (2026-10-30)

## Two stages, kept apart
1. **Eligibility** (`modules/matching/eligibility.ts`, pure, versioned `eligibility-v1`) decides whether mandatory conditions are positively met. Outcomes: `eligible`, `ineligible`, `pending_verification`, `needs_review`, `unavailable`, `expired_credential`. The most severe outcome wins, but **every reason is returned**; nothing is hidden or filtered out.
2. **Ranking** (`ranking.ts`, versioned `ranking-v1`) runs **only for `eligible` candidates**. Seven job-relevant factors with configurable weights (default 25/20/15/15/10/10/5, stored in `platform_settings`, must total 100). No names, age, gender, ethnicity, photos or proxies are inputs. Each factor returns a value and a plain-language note.

Neither stage uses AI. There is no code path from a score or recommendation to an offer: `offer_sent` and `accepted` re-run eligibility inside the transaction and are refused (with reasons) unless the outcome is `eligible`.

## Mandatory-condition rules (v1)
- Profession must match; restricted/suspended accounts are ineligible.
- Mandatory license (type + state) and certification (type) requirements: `verified` is met (the verification method is carried through so reviewers can see "document review" vs "primary source"); submitted/pending is `pending_verification`; expired is `expired_credential`; missing, unsubmitted, needs-more-info, unable-to-verify, rejected and revoked are `ineligible`.
- A same-type license from another state, a specialty not on the profile, self-reported experience below the minimum, and `other` (free-text) requirements give `needs_review`. Compact-license privileges are **not** evaluated automatically.
- Selected shifts must fit the weekly availability in the **facility's time zone** (overnight windows supported), the available-from date, and not overlap shifts the professional already accepted. No availability on file gives `needs_review`.

## Applications
Statuses follow the blueprint. Facilities drive `under_review … interviewed`, `offer_sent`, `rejected`, `cancelled`; professionals drive `withdrawn`, `accepted`, `declined`. `accepted` records acceptance only; assignments, timesheets and fill logic are Release 3. Applying is refused up front for `ineligible`, `expired_credential` and `unavailable` (with reasons); `pending_verification` and `needs_review` may apply.
Snapshots (`candidate_matches`: outcome, full eligibility JSON, score, explanation, rules and weights versions) are written at apply, offer and accept, including refused attempts. The candidate list and detail are evaluated live.

## Privacy
Facilities see applicant name, headline, location, work history and credential **status labels** only: never credential numbers, documents, review notes, email or phone.

## Notifications
In-app rows are created for application events, organization review decisions and credential review decisions. Email is best-effort after the in-app row, with an honest status (`not_delivered` without a provider, `failed`, `skipped` by preference) and contains only a short title. There is no durable queue or retry yet, so email delivery is not guaranteed.

## Known limits
- Candidate lists evaluate at most 500 applicants per job in memory.
- Ranking has no travel-distance factor (no geocoding); location uses preferred states.
- Weights and rules have not been reviewed by domain experts or counsel.
