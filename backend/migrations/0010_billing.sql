-- Phase 2: manual invoicing. BSM invoices the organization that owns a job a platform fee on each completed assignment.
-- Nothing here moves money: payment is recorded by a finance admin after it was received outside the platform.

CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  number text UNIQUE,                                  -- assigned when issued, so drafts never consume numbers
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),   -- fee rate in force when generated
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  due_date date,
  issued_at timestamptz,
  paid_at timestamptz,
  payment_method text CHECK (payment_method IN ('bank_transfer', 'check', 'card_offline', 'other')),
  payment_reference text,
  void_reason text,
  voided_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX invoices_org_idx ON invoices (organization_id, status, created_at DESC);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  description text NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0),        -- scheduled shift length; no timesheets exist yet
  rate_cents integer NOT NULL CHECK (rate_cents >= 0),
  gross_cents bigint NOT NULL CHECK (gross_cents >= 0),
  fee_bps integer NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  voided boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- An assignment can be on at most one live invoice; voiding an invoice frees its assignments.
CREATE UNIQUE INDEX invoice_lines_assignment_live_uq ON invoice_lines (assignment_id) WHERE NOT voided;
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

ALTER TABLE notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('application_updates','review_decisions','support_updates','billing_updates'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check
  CHECK (category IN ('application_updates','review_decisions','support_updates','billing_updates'));
