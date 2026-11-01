-- Unfilled shift recovery. A facility switches it on (per organization, with limits). When an offer expires or is declined
-- and the shift is still short, the platform keeps going: it offers the shift to the next eligible people, within the
-- facility's limits, and escalates to the facility with the shortage and next steps if it still cannot be filled.
-- Also: a short undo window after a professional accepts a shift.

CREATE TABLE shift_recovery_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  enabled_by uuid REFERENCES users(id),                       -- offers are made on this person's behalf and audited as such
  max_outreach integer NOT NULL DEFAULT 5 CHECK (max_outreach BETWEEN 1 AND 25),      -- automatic offers/requests per shift, ever
  offer_hours integer NOT NULL DEFAULT 12 CHECK (offer_hours BETWEEN 1 AND 72),       -- how long an automatic offer stays open
  escalate_hours integer NOT NULL DEFAULT 48 CHECK (escalate_hours BETWEEN 2 AND 336), -- escalate if still short this close to the start
  min_lead_hours integer NOT NULL DEFAULT 2 CHECK (min_lead_hours BETWEEN 0 AND 48),   -- no new automatic outreach this close to the start
  include_float_pool boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shift_recovery (
  shift_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'filled')),
  started_by text NOT NULL DEFAULT 'auto' CHECK (started_by IN ('auto', 'manual')),
  last_run_at timestamptz,
  escalated_at timestamptz,
  escalation jsonb,                                            -- the shortage and recommended next steps, as sent to the facility
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id)
);
CREATE INDEX shift_recovery_org_idx ON shift_recovery (organization_id, status);

ALTER TABLE shift_offers ADD COLUMN origin text NOT NULL DEFAULT 'facility' CHECK (origin IN ('facility', 'recovery'));
ALTER TABLE float_requests ADD COLUMN origin text NOT NULL DEFAULT 'facility' CHECK (origin IN ('facility', 'recovery'));

-- Set when a professional undoes an acceptance within the undo window. Such cancellations do not count against reliability.
ALTER TABLE assignments ADD COLUMN undone_at timestamptz;
