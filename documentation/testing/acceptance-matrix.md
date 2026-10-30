# Release 1 acceptance matrix

Maps the blueprint's 15 essential acceptance tests to automated tests in `backend/tests/`. All of them exercise the **HTTP API**; there is no
browser UI yet, so UI states (loading, empty, error, permission-denied screens), accessibility checks and browser end-to-end tests are **not covered**.

| # | Acceptance test | Covered by | Status |
|---|---|---|---|
| 1 | A facility user cannot read or change another organization's private records | `tenant-isolation.test.ts`, `onboarding.test.ts` (facilities), `jobs.test.ts`, `applications.test.ts`, `e2e-release1.test.ts` #13 | Covered |
| 2 | A professional can register and create a profile without an agency | `professional.test.ts` (profile), `e2e-release1.test.ts` #4-5 | Covered |
| 3 | A professional can upload a credential document privately | `professional.test.ts` (private document upload and access) | Covered (local-disk storage; production bucket adapter not built) |
| 4 | A facility cannot access a credential document without explicit permission and business purpose | `professional.test.ts`, `applications.test.ts` (no numbers/documents in facility views), `e2e-release1.test.ts` #6 | Covered, by denying all facility access. No permissioned-access grant exists to test (ASSUMPTIONS #6, #15) |
| 5 | A submitted credential is not automatically marked verified | `professional.test.ts` (credential review), `e2e-release1.test.ts` #6 | Covered |
| 6 | An expired or invalid mandatory credential prevents a candidate being labeled eligible | `matching.test.ts` (every credential status → outcome), `applications.test.ts` (acceptance blocked after expiry) | Covered |
| 7 | A pending verification is shown as pending, not verified | `professional.test.ts`, `applications.test.ts`, `e2e-release1.test.ts` #7 | Covered |
| 8 | A facility can publish a valid job or shift | `jobs.test.ts` (publishing), `e2e-release1.test.ts` #8 | Covered |
| 9 | A professional can apply directly to a published opportunity | `applications.test.ts`, `e2e-release1.test.ts` #9-10 | Covered |
| 10 | A facility can review and update an application through allowed transitions | `applications.test.ts`, `e2e-release1.test.ts` #11-12 | Covered |
| 11 | Unauthorized users cannot change application or credential states | `applications.test.ts`, `professional.test.ts`, `hardening.test.ts` (47 endpoints reject anonymous callers) | Covered |
| 12 | Administrative review actions are auditable | `onboarding.test.ts`, `professional.test.ts`, `operations.test.ts` (audit search), `e2e-release1.test.ts` #15 | Covered |
| 13 | Agency representation cannot be created without the required professional consent | n/a | **Not applicable yet**: the agency domain is Release 2 and has no tables or endpoints |
| 14 | API validation rejects malformed and out-of-range inputs | validation cases in every suite; `e2e-release1.test.ts` #14 | Covered |
| 15 | Passwords, tokens and private document contents do not appear in logs | `hardening.test.ts` (full flow with a captured logger), `crypto.test.ts` (redaction) | Covered |

## Release 1 journeys (blueprint §3)
Journeys 1-12 and 13 (permissions and organization boundaries) run in sequence in `e2e-release1.test.ts`. Journey 9 (facility searches for professionals) is built: anonymized, opt-in talent search with invitations to apply (ADR 0005; `talent.test.ts`).

## Other automated checks
Security headers/CORS/cookies, global rate limiting, readiness, dump/restore validation: `hardening.test.ts`. Admin dashboard, user suspension, job oversight, state configuration, metrics: `operations.test.ts`. Support workflow: `support.test.ts`.
