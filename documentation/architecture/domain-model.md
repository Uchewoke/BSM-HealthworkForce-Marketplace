# Domain Model (draft ERD)

Draft for review; migrations are the source of truth once written.

```mermaid
erDiagram
  users ||--o{ sessions : has
  users ||--o| professionals : "may be"
  users ||--o{ organization_members : joins
  organizations ||--o{ organization_members : has
  organizations ||--o{ organization_invitations : issues
  organizations ||--o{ facilities : manages
  facilities ||--o{ facility_locations : has
  facility_locations ||--o{ departments : has
  organizations ||--o{ organization_reviews : "onboarding history"
  professionals ||--o{ professional_education : has
  professionals ||--o{ professional_experience : has
  professionals ||--o{ professional_availability : has
  professionals ||--o{ licenses : holds
  professionals ||--o{ certifications : holds
  licenses ||--o{ credential_documents : "evidence"
  certifications ||--o{ credential_documents : "evidence"
  licenses ||--o{ credential_verifications : "review history"
  facilities ||--o{ jobs : posts
  jobs ||--o{ shifts : has
  jobs ||--o{ job_requirements : needs
  jobs ||--o{ applications : receives
  professionals ||--o{ applications : submits
  applications ||--o{ application_events : "status history"
  users ||--o{ notifications : receives
  users ||--o{ audit_logs : "actor"
  staffing_agencies ||--o{ agency_professionals : represents
  professionals ||--o{ agency_representation_consents : grants
  staffing_agencies ||--o{ agency_submissions : makes
```

## Principles
- UUID PKs, UTC timestamps, constrained status enums, FK + unique constraints.
- Organization-owned rows carry `organization_id`; services verify active membership; RLS backs this up.
- Account status, profile completeness, credential status and job eligibility are separate fields.
- Credential numbers are sensitive (encrypted at rest); document bytes live in private object storage, DB holds metadata only.
- Agency tables exist from the first schema pass; agency workflows ship in Release 2.
- State/jurisdiction rules live in configuration tables.
