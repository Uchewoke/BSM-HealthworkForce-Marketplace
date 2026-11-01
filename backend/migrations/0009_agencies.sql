-- Phase 2: staffing agencies. An agency keeps a roster of professionals who have consented to be represented,
-- is granted access to specific facility jobs, and submits roster candidates. A submission is an ordinary
-- application (submitted_by_agency_id set), so eligibility, offers and assignments reuse the existing pipeline.

CREATE TABLE agency_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES organizations(id),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'declined', 'removed')),
  invited_by uuid REFERENCES users(id),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, professional_id)
);
CREATE INDEX agency_roster_professional_idx ON agency_roster (professional_id, status);

-- A facility grants an agency access to one of its jobs; agencies never see jobs they were not granted.
CREATE TABLE job_agency_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  agency_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, agency_id),
  FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id)
);
CREATE INDEX job_agency_access_agency_idx ON job_agency_access (agency_id, status);

ALTER TABLE applications ADD COLUMN submitted_by_agency_id uuid REFERENCES organizations(id);
ALTER TABLE applications ADD COLUMN submitted_by_user_id uuid REFERENCES users(id);
CREATE INDEX applications_agency_idx ON applications (submitted_by_agency_id, created_at DESC) WHERE submitted_by_agency_id IS NOT NULL;
