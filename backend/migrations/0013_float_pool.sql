-- Phase 3: regional float pool. Professionals opt in to a named region's pool; facilities that accepted the exchange terms for
-- that region can see anonymized pool cards and send shift requests. A professional stays anonymous until they accept a
-- request; acceptance then flows through the normal application, shift-offer and assignment machinery, so every eligibility,
-- scheduling-conflict and capacity rule still applies.

CREATE TABLE exchange_regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  states text[] NOT NULL CHECK (cardinality(states) > 0),           -- US state codes this region covers
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exchange_regions_name_uq ON exchange_regions (lower(name));

-- A professional's explicit, versioned consent to be shown to participating facilities in one region.
CREATE TABLE float_pool_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id uuid NOT NULL REFERENCES exchange_regions(id),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  UNIQUE (region_id, professional_id)
);
CREATE INDEX float_pool_members_professional_idx ON float_pool_members (professional_id, status);

-- A facility's agreement to the exchange terms for one region. Staff can suspend it.
CREATE TABLE exchange_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  region_id uuid NOT NULL REFERENCES exchange_regions(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'suspended')),
  status_reason text,
  terms_version text NOT NULL,
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, region_id)
);

CREATE TABLE float_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  region_id uuid NOT NULL REFERENCES exchange_regions(id),
  shift_id uuid NOT NULL,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  hourly_rate_cents integer NOT NULL CHECK (hourly_rate_cents BETWEEN 0 AND 100000),
  message text CHECK (char_length(message) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired', 'failed')),
  failure_reason text,
  application_id uuid REFERENCES applications(id),     -- exists only once the professional accepted
  offer_id uuid REFERENCES shift_offers(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id)
);
CREATE UNIQUE INDEX float_requests_pending_uq ON float_requests (shift_id, professional_id) WHERE status = 'pending';
CREATE INDEX float_requests_org_idx ON float_requests (organization_id, created_at DESC);
CREATE INDEX float_requests_professional_idx ON float_requests (professional_id, status, created_at DESC);

-- Where an application came from, so reports and the facility view can say so.
ALTER TABLE applications ADD COLUMN source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'agency', 'float_pool'));
UPDATE applications SET source = 'agency' WHERE submitted_by_agency_id IS NOT NULL;
