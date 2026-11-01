# ADR 0007: Unfilled shift recovery and one-tap acceptance

Status: accepted (2026-11-01) as a safe default; the numbers and scope below were chosen by the engineer, not the product owner, and need confirmation (see ASSUMPTIONS.md 55-58).

## Why
The platform should not just show vacancies; it should help resolve them. When an offer expires or is declined, someone has to ask the next person, and if the shift still cannot be filled, the facility must hear about it in time to act.

## Unfilled shift recovery

### Approval model: off until a person turns it on
- An owner or admin (`org.update`) switches it on per organization (`shift_recovery_settings`). It is **off by default**; nothing is sent automatically until then.
- The person who turns it on is recorded (`enabled_by`). Automatic offers are made, and audited, **on that person's behalf**. If they stop being an active member of the organization, recovery **pauses** until an owner or admin turns it on again.
- Limits the facility controls: most automatic offers per shift (default 5), how long each stays open (12 h, never past the start), how close to the start a shift must be before the facility is told (48 h), how close before new automatic offers stop (2 h), and whether float pool members are included.
- Individual shifts can be started by hand (even before any offer has failed) and stopped at any time.

### What starts it
Recovery for a shift begins when outreach for it has **actually ended without filling it** (an offer or float request was declined or expired), or when the facility starts it. It does not start on a brand new shift, so automatic offers never pre-empt the facility's own review of applicants.

### Who is asked, in order
1. **Applicants** who applied for that shift, are still open, and are **currently eligible**, best-ranked first.
2. If allowed and the shift is in a region the facility participates in, **float pool members** who are currently eligible, best-ranked first (they remain anonymous until they accept).
Anyone already offered or requested for the shift in any status is never asked again. Eligibility is never relaxed: the same engine and the same re-check at offer and at acceptance apply. Ranking only orders people who are already eligible. Automatic offers use the rate already set on the shift; with no rate, nothing is sent and the facility is told.

### Escalation
Once per shift (until the facility restarts it), when no offer is still waiting **and** nothing more can be sent (no one else eligible, the limit was reached, no rate, or too close to the start), or when the shift is within the configured number of hours of its start and still short. The facility gets a notification and a record on the Shift recovery page with: positions still open, hours to the start, who was asked and how it went, how many candidates are waiting on credential review or are unavailable, why automatic outreach stopped, and **suggested next steps** derived from those facts (finish credential reviews, set a rate, raise the limit, join the exchange, share the job with agencies, adjust the offer, or tell people early if it cannot be covered). The suggestions are advice, not actions.

### When it runs
A timer in the API process runs a pass every `SHIFT_RECOVERY_INTERVAL_MINUTES` (default 5; 0 turns it off). Facilities can also press "Check now". Offers and requests are expired at the start of each pass. This is enough for one API instance; with several, run it from a single worker so passes do not race (see `workers/README.md`).

### What it does not do
It never contacts people outside the platform, never uses talent-search candidates (they are invitations to apply, not shift offers), never changes a shift's rate, never lowers requirements, and never cancels or edits anything.

## One-tap acceptance
- The offer shows facility and location (name, address, city, state), start and end, hourly rate, expiry, the job's required credentials (mandatory and preferred), the facility's message and shift notes, and **whether the professional meets the requirements right now** (the same check the platform repeats on acceptance). If they do not, Accept is disabled and the reasons are shown.
- **Accept is a single tap** (no confirmation dialog). To make a mistake cheap, the professional can **undo within 5 minutes**: no reason needed, the shift reopens, the facility is told, and the cancellation does **not** count against their reliability or the facility's cancellation statistics. After 5 minutes, or once the shift has started, undo is refused and the normal cancellation (with a reason) applies. Decline keeps a confirmation, since it cannot be taken back.
- After accepting, the screen says what happens next: the booking is confirmed and the facility has been told, how to undo it, and that hours are recorded under Timesheets after the shift.
- The offer screen is a single-column card layout with larger touch targets and stacked buttons on narrow screens. It has not been tested on a real phone.

## Known limits / open questions
- Whether automatic outreach on a facility's behalf, including to float pool members, needs additional notice or consent wording, and whether the "approved by one person" attribution is sufficient, needs counsel.
- Offers go out as soon as a pass finds someone, at any hour; there are no quiet hours.
- Candidates are ordered by the existing ranking; there is no fairness rotation among applicants.
- "Administrative workflow after acceptance" is limited to what the platform already does (assignment, notifications, timesheet, review, billing). There is no onboarding paperwork, orientation or facility-specific forms.
- No push notifications or native app; a professional learns of an offer through in-app notification and, where configured, email.
