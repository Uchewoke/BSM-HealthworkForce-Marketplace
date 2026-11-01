# Database coverage vs. the target table list

Status of the proposed core tables against the migrations in `backend/migrations/` (0001-0007). Update this file whenever a migration adds or renames a table. See also `../architecture/domain-model.md` and `../decisions/0001-sql-migrations-and-pglite.md`.

## Mapping

| Target table | Status | Notes |
|---|---|---|
| `users`, `organizations`, `organization_members`, `facilities`, `departments` | Built (0001, 0002) | Also `facility_locations`, `organization_invitations`, `organization_reviews`, `mfa_methods`, `sessions`, `user_tokens` |
| `professionals`, `professional_specialties`, `professional_experience`, `professional_availability` | Built (0003) | Also `professions`, `specialties`, `professional_education`, `professional_preferences` |
| `licenses`, `certifications` | Built as one `credentials` table | Type field distinguishes them; split only for a concrete need |
| `credential_documents`, `credential_verifications` | Built (0003) | Verification is an append-only history, not a boolean |
| `jobs`, `shifts`, `applications` | Built (0004, 0005) | Also `job_requirements`, `job_events`, `application_shifts`, `application_events` |
| `shift_requirements` | Not built | Shifts inherit the job's requirements |
| `shift_matches` | Built as `candidate_matches` (0005) | Decision-point match snapshots |
| `shift_offers`, `assignments`, `assignment_status_history` | Built (migration 0008, unverified until run) | Release 3a; timesheets and payments remain Release 3 |
| `staffing_agencies`, `agency_professionals`, `client_contracts`, `candidate_submissions` | Not built | Release 2 |
| `timesheets`, `invoices`, `payments` | Not built | Release 3 |
| `notifications`, `audit_logs` | Built (0001, 0005) | Also `notification_preferences` |
| `reviews` | Not built | Not scheduled |

Tables outside the proposed list: `support_tickets`, `support_ticket_messages`, `state_configurations`, `platform_settings`, `talent_refs`, `talent_invitations`.

## Design principles

- **Verification history.** `credential_verifications` records actor, from/to status, method (`document_review` or `primary_source`), source reference, a professional-visible reason and an internal note. Never replace it with a verified flag.
- **Permanent hires vs. shift bookings.** One `applications` table serves both; `application_shifts` links an application to specific shifts. Offers, onboarding and assignments differ between the two, so when Release 3 adds `shift_offers` and `assignments`, keep them separate from permanent-hire offers.
- **Tenant isolation.** Org-owned tables use composite foreign keys that include `organization_id`. New org-owned tables must do the same.
- **Schema changes** go through migrations only.
