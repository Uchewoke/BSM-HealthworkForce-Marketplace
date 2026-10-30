-- Facility onboarding: profile fields, review history, invitations hardening, facilities/locations/departments.

ALTER TABLE organizations
  ADD COLUMN legal_name text,
  ADD COLUMN contact_email text,
  ADD COLUMN contact_phone text,
  ADD COLUMN website text,
  ADD COLUMN state text CHECK (state ~ '^[A-Z]{2}$');

-- Every status change (submission and BSM decisions) is recorded here.
CREATE TABLE organization_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('organization','platform')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text,         -- visible to the organization
  internal_note text,  -- visible to platform reviewers only
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_reviews_org_idx ON organization_reviews (organization_id, created_at);

ALTER TABLE organization_invitations
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN accepted_by uuid REFERENCES users(id),
  ADD CONSTRAINT organization_invitations_role_chk CHECK (role IN (
    'facility_admin','hiring_manager','recruiter','scheduler','finance','read_only'));
CREATE UNIQUE INDEX organization_invitations_pending_uq
  ON organization_invitations (organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  facility_type text NOT NULL CHECK (facility_type IN
    ('hospital','clinic','long_term_care','rehabilitation','home_health','other')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX facilities_org_name_uq ON facilities (organization_id, lower(name));

-- Composite foreign keys make cross-tenant parent/child links impossible at the database level.
CREATE TABLE facility_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  facility_id uuid NOT NULL,
  name text NOT NULL,
  address_line1 text NOT NULL,
  address_line2 text,
  city text NOT NULL,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  postal_code text NOT NULL,
  timezone text NOT NULL,   -- IANA zone, e.g. America/New_York
  phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX facility_locations_facility_idx ON facility_locations (facility_id);
CREATE INDEX facility_locations_state_idx ON facility_locations (state) WHERE active;

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES facility_locations (id, organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX departments_location_name_uq ON departments (location_id, lower(name));
