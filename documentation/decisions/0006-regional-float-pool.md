# ADR 0006: Regional float pool and demand forecasting

Status: accepted (2026-11-01). Model chosen by the product owner; pending legal/privacy and competition-law review before any pilot.

## Decisions (product owner's answers)
1. **Regional exchange = a shared float pool.** Professionals opt in to a named region's pool; facilities that agreed to the exchange terms for that region can see them and request them for specific shifts. (Not a shift-sharing board between facilities, and not aggregate insights only.)
2. **Forecasting = transparent statistics.** A simple, explainable method with ranges and an explicit "not enough history" state. No model training, no AI in the loop.

## The float pool

### What is new compared with talent search (ADR 0005)
Talent search already lets a facility find opted-in professionals anonymously and invite them to *apply* to a job. The pool adds: a **region** scope, **shift-level availability and eligibility matching** ("who can actually work this shift"), and a **direct shift request** that books through the existing offer and assignment code. It is a separate opt-in with its own versioned consent.

### Privacy contract
- **Two consents, both versioned and recorded.** A professional's consent (`float_pool_members.consent_version`) and a facility's agreement to the exchange terms (`exchange_participants.terms_version`). Texts live in `exchange/terms.ts`; changing them means bumping the version.
- **Anonymous cards.** Profession, specialties, city and state, years of experience, credential *status labels*, and weekly availability windows. Never a name, contact detail, employer, school, pay expectation, credential number, document, or anything about who else the person works for. Each card carries the per-organization random reference from `talent_refs`, so two facilities cannot correlate a person.
- **Identity is revealed only on acceptance.** A request is a `float_requests` row, not an application. The application (which exposes the name) is created only when the professional accepts. Declining tells the facility only that "a pool member declined".
- **No fixed pay information crosses facilities.** The facility sets the rate on each request. The pool shows no pay history, rates, or other facilities' engagement. The exchange terms forbid agreeing pay with other facilities or coordinating who may hire whom.
- **Small counts are hidden.** The capacity summary shows "fewer than 5" instead of a number for small groups.
- Pool search needs `professionals.search` and an approved organization, is rate limited, capped to 300 results, and audited (filter names and counts, never results). Requests are capped at 40 per organization per day and expire after 48 hours or at shift start.
- Leaving the pool, a facility leaving, or staff suspending a facility withdraws waiting requests.

### Booking reuses the existing machinery
On accept, in order: (1) pre-flight checks that reveal nothing (membership, participation, shift still open and not full, **eligibility**), (2) create the application (`source = 'float_pool'`) and its shift link, (3) `createShiftOffer` (re-checks eligibility), (4) `respondToShiftOffer` (re-checks eligibility, scheduling conflicts and capacity, creates the assignment). Eligibility is never bypassed; a request cannot be sent, and an acceptance cannot succeed, for someone who is not currently `eligible`. Timesheets, reviews, reliability, analytics and billing then apply unchanged.

If something changes between the pre-flight and the booking (for example another person takes the last position), the application is withdrawn and the request is marked `failed` with the reason.

### Regions
Regions are named sets of US states, created and edited by staff (`admin.marketplace_oversight`). State-level is coarse (a "region" covering Georgia is statewide). Finer geography is future work.

## Forecasting
- Weekly positions needed, from the organization's own non-cancelled shifts (UTC weeks, up to two years), complete weeks only.
- **Method:** recency-weighted average of the last 6 weeks, a damped trend (last 4 weeks vs the 4 before, clipped to 0.8–1.25 and damped over 4 weeks), range from the spread of the method's own one-week-ahead errors (80%-style, widening with distance). **No seasonality.**
- **Minimums:** at least 8 weeks of history and 10 positions; otherwise the response is `insufficient_history` with the reason, never a number.
- **Self-check:** walk-forward back-test on the latest weeks (each predicted using only earlier weeks): mean absolute error, error as a share of average demand, and how often the actual landed inside the range. Confidence is `low`/`medium`/`high` from history length and that error.
- Positions already posted for a future week are a floor on that week's forecast. "Expected unfilled" applies the organization's fill rate over the last 12 complete weeks.
- Per-profession forecasts for the five busiest professions, each with its own minimums.
- Pool capacity (anonymous counts by profession) is shown beside the forecast as the supply side. It is context, not a prediction of availability for a given shift.

## Known limits / open questions
- Whether a shared pool, rate-setting rules and non-solicitation terms raise competition-law or worker-classification issues needs counsel.
- Whether showing availability windows plus city and experience makes small pools re-identifiable (see ADR 0005's same caveat). Mitigations: opt-in, result cap, rate limit, audit, hidden small counts.
- The consent and exchange-terms wording are drafts without legal review.
- Forecasts ignore seasonality, holidays, and events, and treat all history as equally relevant. A new facility's first weeks are unrepresentative.
- A professional who accepts through the pool is the facility's responsibility to onboard; the platform does not vet the facility's fitness beyond approval.

## Update: legal gate, all-or-nothing booking, Beta forecast
- The pool is gated by a recorded legal sign-off (see `legal_signoffs`, Admin > Legal sign-off). It is off in a fresh install and for everyone until a super admin records the sign-off. The briefing for counsel is `documentation/compliance/counsel-review-brief.md`.
- Booking on acceptance is now one transaction: the application, the offer and the acceptance either all happen or none do. The earlier cleanup-after-failure approach (and its brief identity exposure) is gone.
- Regions stay state-level for the pilot (product owner).
- The forecast is labelled Beta and needs 12 weeks of history (was 8); confidence is "low" below 16 weeks.
