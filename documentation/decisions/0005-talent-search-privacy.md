# ADR 0005: Facility search of professionals: privacy contract

Status: accepted (2026-10-30). Decided by the product owner; pending legal/privacy review before any pilot.

## Decision (product owner's answers)
1. **Visibility: anonymized card.** A facility sees only a profession, specialties, city and state, years of experience, the *status* of credentials (with how they were verified), and a general availability summary (days of the week, preferred work types and states, available-from date).
   It never sees a name, photo, email, phone, headline or summary text, employers, schools, pay expectation, credential numbers or documents.
2. **Who appears: opt-in only.** A professional is searchable only after switching on "discoverable" (off by default, reversible at any time, change audited).
3. **Contact: invite to apply.** A facility can send an in-app invitation tied to one of its open jobs. It does not receive contact details. Identity is revealed only if the professional applies, through the normal application flow.

## How it is enforced
- `professionals.discoverable` defaults to `false`; search requires it, an `active` account and an `active` user.
- Each search result carries a random per-(organization, professional) reference (`talent_refs`), so a facility can act on a card without learning who it is, and two facilities cannot correlate the same person. References only work within their organization.
- Search requires the `professionals.search` permission (owner, admin, hiring manager, recruiter) and an approved organization; it is rate limited (60/min/user), capped to the first 300 results with 25 per page, and every search is audited (filter names and result count, never the results).
- Invitations: approved organization, own open job, no existing application, one pending invitation per person and job, 30 per organization per day, expire after 14 days, can be withdrawn by the facility or declined by the professional. Declining does not tell the facility who declined.
- When a job is chosen, each card is also run through the same eligibility engine and, if eligible, the explainable ranking. Ineligible and pending people stay visible with the reasons; ranking never overrides eligibility.
- Tests assert the absence of every identifying field in the raw JSON.

## Known limits / open questions
- Combinations of fields (a small town, a rare specialty and exact years of experience) can make a person re-identifiable to someone who knows them. Mitigations are the opt-in, the result cap and rate limit, and the audit trail; a k-anonymity threshold or coarser location could be added.
- Whether the applicable privacy laws treat this as a "sale" or "sharing" of personal information, and what notice/consent wording is required, needs counsel.
- Turning discoverability off does not retract invitations already sent; the professional can still decline them.
