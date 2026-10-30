-- Facility search of professionals: opt-in discoverability, per-organization pseudonymous references, invitations to apply.

ALTER TABLE professionals
  ADD COLUMN discoverable boolean NOT NULL DEFAULT false,      -- opt-in; off by default
  ADD COLUMN discoverable_updated_at timestamptz;
CREATE INDEX professionals_discoverable_idx ON professionals (profession_id) WHERE discoverable;

-- A random reference per (organization, professional). It lets a facility act on a search result without learning who the
-- person is, and prevents correlating the same person across organizations.
CREATE TABLE talent_refs (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  ref text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, professional_id)
);

CREATE TABLE talent_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES users(id),
  message text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','declined','withdrawn')),
  application_id uuid REFERENCES applications(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id)
);
CREATE UNIQUE INDEX talent_invitations_pending_uq ON talent_invitations (job_id, professional_id) WHERE status = 'pending';
CREATE INDEX talent_invitations_professional_idx ON talent_invitations (professional_id, created_at DESC);
CREATE INDEX talent_invitations_org_idx ON talent_invitations (organization_id, created_at DESC);
