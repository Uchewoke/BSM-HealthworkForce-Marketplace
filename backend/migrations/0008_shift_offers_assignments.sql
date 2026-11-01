-- Release 3a: shift-based booking path (offers -> assignments -> history).
-- Permanent hires keep using applications.offer_sent / accepted.

CREATE TABLE shift_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  application_id uuid NOT NULL,
  professional_id uuid NOT NULL REFERENCES professionals(id),
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn', 'expired')),
  hourly_rate_cents integer NOT NULL CHECK (hourly_rate_cents BETWEEN 0 AND 100000),
  message text,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (application_id, organization_id) REFERENCES applications (id, organization_id),
  FOREIGN KEY (application_id, shift_id) REFERENCES application_shifts (application_id, shift_id)
);

CREATE UNIQUE INDEX shift_offers_one_open_per_app_shift
  ON shift_offers (application_id, shift_id) WHERE status = 'sent';
CREATE INDEX shift_offers_org_idx ON shift_offers (organization_id, status, created_at DESC);
CREATE INDEX shift_offers_professional_idx ON shift_offers (professional_id, status, created_at DESC);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  professional_id uuid NOT NULL REFERENCES professionals(id),
  offer_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'completed', 'no_show', 'cancelled_by_facility', 'cancelled_by_professional')),
  hourly_rate_cents integer NOT NULL CHECK (hourly_rate_cents BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (offer_id, organization_id) REFERENCES shift_offers (id, organization_id)
);

CREATE UNIQUE INDEX assignments_one_confirmed_per_shift_pro
  ON assignments (shift_id, professional_id) WHERE status = 'confirmed';
CREATE INDEX assignments_org_idx ON assignments (organization_id, status, created_at DESC);
CREATE INDEX assignments_professional_idx ON assignments (professional_id, status, created_at DESC);

CREATE TABLE assignment_status_history (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  actor_user_id uuid REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('professional', 'organization')),
  from_status text,
  to_status text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assignment_status_history_idx ON assignment_status_history (assignment_id, seq);
