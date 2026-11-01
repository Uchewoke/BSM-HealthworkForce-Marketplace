# Briefing for legal counsel: regional float pool, automatic outreach, one-tap acceptance

Prepared for: BSM HealthForce Marketplace's counsel. Written by the engineering side, in plain language. It describes what the software does and asks specific questions. It is not legal advice and does not assume any answer.

**How your answer is used.** Two features are switched off for everyone until a BSM super admin records that legal review is complete (Admin > Legal sign-off: who, when, and a reference to your written advice). Switching a feature off again withdraws what is waiting. Nothing in the product treats that record as a legal conclusion; it only controls availability.

Related records: ADR 0005 (talent-search privacy), ADR 0006 (float pool and forecasting), ADR 0007 (unfilled-shift recovery and one-tap acceptance), `ASSUMPTIONS.md` items 31, 44, 45, 48 and 51-58.

---

## 1. Background: what the platform is and is not
BSM operates a technology marketplace only: it does not employ professionals and is not a party to the staffing relationship (decision log #4). Facilities, professionals and agencies contract with each other. Pay and working terms are agreed directly. BSM does not process pay. BSM does invoice facilities a platform fee on completed work (manual invoicing, recorded by staff).

**Open threshold question for counsel:** does operating this marketplace, and in particular a shared pool of professionals that facilities can request for shifts, trigger healthcare staffing agency, nurse registry or employment-agency licensing in any state where it will operate (start with Georgia)? Does anything we describe below make BSM an employer or joint employer?

---

## 2. Feature A: Regional float pool (switch name: `float_pool`)

### What it does
- BSM staff define named regions (sets of US states). A professional can opt in to a region's pool. A facility that has a location in the region can accept the exchange terms and then see an anonymous card for each pool member and send a request for one specific open shift.
- The professional stays anonymous until they accept. Declining tells the facility only that "a pool member declined". Accepting reveals their name to that facility through the ordinary application, and books the shift. Their credentials and schedule are checked again at that moment; an ineligible person cannot be requested or accepted.
- The facility sets the pay rate on each request. The pool shows no pay history, no rates from other facilities, and nothing about who else a person works for.

### What a facility sees on a card (and does not)
Sees: profession, specialties, city and state, years of experience, the status of each credential ("verified with the primary source", "pending review", etc., not numbers or documents), and weekly availability windows.
Never sees: name, contact details, photo, employers, schools, pay expectations, credential numbers or documents, or any other facility's dealings.

### Safeguards in place
Opt-in only (separate from the job-search "discoverable" setting); consent text is versioned and recorded per person; the facility's agreement is versioned and recorded; each facility gets its own random reference for a person, so two facilities cannot tell they are looking at the same person; counts under 5 are hidden; search is rate limited, capped and audited; requests expire after 48 hours; staff can suspend a facility, which withdraws its waiting requests; a person can leave at any time, which withdraws their waiting requests.

### Texts shown to people (verbatim, version `float-pool-v1` and `exchange-terms-v1`)
**Professional consent**

> If you join a regional float pool, facilities in that region that have agreed to the exchange terms can see an anonymous profile card: your profession, specialties, city and state, years of experience, the status of your credentials, and the days and times you have said you are available.
>
> They never see your name, contact details, employers, schools, pay expectations, credential numbers or documents, and they cannot see who else you work for.
>
> A facility can send you a request for a specific shift. Your identity is shared with that facility only if you accept. You can decline, and you can leave the pool at any time; leaving withdraws requests you have not answered.
>
> Accepting a request books the shift like any other. Your credentials and schedule are checked again when you accept.

**Facility exchange terms**

> By joining the regional exchange for a region, your organization agrees to use pool information only to request professionals for your own open shifts in that region.
>
> Pool members are shown anonymously. You must not try to identify, contact or recruit a pool member outside the platform, copy or share pool information with others, or use it to discourage a professional from working elsewhere.
>
> You may not use the exchange to agree with other facilities on pay rates, or to coordinate who may hire whom. You set the rate for each request yourself.
>
> BSM may suspend your participation for breaking these terms.

### Questions for counsel
1. **Competition law.** Does a shared pool that several competing facilities draw from, with facilities setting their own rate per request, raise antitrust concerns (information exchange, no-poach, wage-fixing)? Are the "no pay coordination" and "no recruiting outside the platform" clauses adequate, too broad, or themselves a problem (restraint on hiring)? Is the combination of anonymity, hidden rates and per-request pricing sufficient?
2. **Worker status.** Does being offered work through a pool, and accepting shifts from several facilities, affect independent-contractor versus employee analysis, or joint-employer exposure for BSM or facilities? Anything we should add or remove from the consent text or product copy?
3. **Privacy.** Does showing an anonymous card to many facilities amount to a "sale" or "sharing" of personal information under applicable privacy law (ADR 0005 raises the same point for talent search)? What notice and consent wording is required? Is the card re-identifiable in small pools (small town, rare specialty, years of experience), and what threshold or coarsening do you recommend?
4. **Credential display.** Is showing credential *status* (not numbers or documents) to prospective facilities appropriate? Any obligations about accuracy of "verified" labels?
5. **Terms and enforceability.** Are the two texts above sufficient as click-through terms? Where should they live (terms of service, separate addendum)? Who is bound on the facility side?
6. **Suspension.** Is BSM's right to suspend a facility, and to withdraw waiting requests, adequately stated?
7. **Licensing.** The threshold question in section 1.

---

## 3. Feature B: Automatic outreach on a facility's behalf (switch name: `shift_recovery`)

### What it does
When an offer for a shift expires or is declined and the shift is still short, the platform can offer the shift to the next best **currently eligible** people, within limits the facility chooses, and tells the facility if it still cannot be filled.
- **Off by default, per organization.** An owner or admin switches it on; the offers are made and audited on that person's behalf, and pause if they stop being an active member.
- **Limits (defaults):** 5 automatic offers per shift, each open 12 hours (never beyond the shift start), no new automatic offers within 2 hours of the start, escalate to the facility within 48 hours of the start. The facility can change these.
- **Who is asked:** first people who applied for that shift and are eligible, then (if the facility allows and the float pool is signed off) eligible float pool members, who remain anonymous until they accept. Anyone already asked is never asked again. Eligibility is never relaxed. Offers use the pay rate already set on the shift; nothing is sent without one.
- **The offer says it was sent automatically.** Message shown: "This shift is still open and you may be a good fit. This offer was sent automatically on the facility's behalf."
- It never contacts anyone outside the platform.

### Questions for counsel
1. **Authority and attribution.** Is it adequate that automatic offers are made on behalf of, and attributed to, the person who switched the feature on, under limits they set? Does the facility need to accept specific terms when turning it on? What wording?
2. **Fairness in selection.** People are ordered by an explainable ranking among those already eligible, after applicants, then pool members. Does this ordering create exposure under anti-discrimination or fair-chance rules (disparate impact), and what should we record or disclose? Do you want the ranking inputs disclosed to professionals?
3. **Records.** What must be retained about automatic decisions (who was offered what, why, when), and for how long?
4. **Notices to professionals.** Is the automatic-offer disclosure above sufficient? Any consent needed before a professional receives automated offers?
5. **Interaction with the pool.** Anything additional required when an automatic request goes to an anonymous pool member?

---

## 4. Feature C: One-tap acceptance with a short undo
- A professional sees the offer's facility and address, times, rate, expiry, required credentials, conditions and notes, and whether they currently qualify, then accepts with **one tap** (no confirmation step). Declining asks for confirmation.
- Acceptance books the shift on the platform. Pay and working terms are between the professional and facility; BSM states it does not process payment or create an employment relationship.
- The professional can **undo within 5 minutes** without giving a reason, and without it counting against their reliability record. After three undos in 30 days a reason is required; staff can see the count. After 5 minutes, cancelling needs a reason and counts.

### Questions for counsel
1. Is a single-tap acceptance a sufficiently clear electronic agreement (E-SIGN/UETA) for a booking of this kind, given the summary shown beforehand? What, if anything, should be added to the screen?
2. Is the undo window and repeat-undo handling reasonable as to facilities relying on bookings and professionals' rights?
3. Does the statement that BSM "does not create an employment relationship" belong on this screen, and is the current wording right?

---

## 5. Cross-cutting questions
- **Reliability and ratings** (shown to facilities as context, never used in eligibility): defamation, dispute and removal policy, anonymity of professionals' reviews of facilities (ASSUMPTIONS #44-45).
- **AI assistant** sends questions and aggregate figures to a third-party model provider (ASSUMPTIONS #48): provider terms, retention, privacy notice.
- **Data retention and deletion** for pool consent records, requests, audit logs.

## 6. Decisions the product owner has already made
Shared float pool model (not a shift-sharing board); anonymous until accepted; facility sets rate per request; state-level regions for the pilot; recovery defaults as listed above; recovery sources are applicants then pool members only (not talent-search candidates); 5-minute undo with a reason after three undos in 30 days; forecast is labelled Beta and needs 12 weeks of history.

## 7. What we need back
For each feature: proceed / proceed with changes / do not proceed, the specific changes to the texts or product, and a reference (memo or ticket id) that a super admin can record when switching the feature on.
