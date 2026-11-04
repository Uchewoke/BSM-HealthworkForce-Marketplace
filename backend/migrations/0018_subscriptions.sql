-- Subscription billing and entitlements. Stripe is the system of record for payment events; these tables are a synchronized projection.
-- Nothing here changes matching, eligibility or ranking. Existing organizations stay 'exempt' (no gating) until staff switch them to 'enforced'.

-- Rollout switch, per organization. 'exempt' = today's behaviour (nothing gated). 'enforced' = paid features need an entitlement.
ALTER TABLE organizations ADD COLUMN billing_mode text NOT NULL DEFAULT 'exempt' CHECK (billing_mode IN ('exempt', 'enforced'));

-- Commercial plan catalog. One row per plan AND billing interval; `tier` groups the monthly and annual rows of the same plan.
-- Prices are integer minor units (29900 = $299.00). Pricing lives here, never in code.
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  tier text NOT NULL,
  name text NOT NULL,
  customer_type text NOT NULL CHECK (customer_type IN ('facility', 'agency')),
  description text NOT NULL DEFAULT '',
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  price_amount bigint NOT NULL CHECK (price_amount >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  stripe_product_id text,
  stripe_price_id text UNIQUE,                       -- a plan can be bought only once staff attach its Stripe price
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Feature definitions per plan. For value_type 'integer', a JSON null means unlimited (a contracted amount).
CREATE TABLE plan_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL CHECK (entitlement_key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  value_type text NOT NULL CHECK (value_type IN ('boolean', 'integer', 'string')),
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, entitlement_key)
);

CREATE TABLE billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_customer_id text NOT NULL,
  billing_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id)
);

-- At most one subscription row per organization. It is written only from authenticated provider data, never from the browser.
CREATE TABLE organization_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),   -- price per interval as billed, before any coupon
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  grace_period_end timestamptz,
  last_event_created timestamptz NOT NULL,           -- provider timestamp of the newest event applied; older events are ignored
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_subscriptions_status_idx ON organization_subscriptions (status);

-- Webhook ledger. Only identifiers, the event type, the outcome and non-personal amounts are kept: never the payload.
CREATE TABLE billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  organization_id uuid REFERENCES organizations(id),
  amount_minor bigint,
  currency text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1,
  last_error_code text,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX billing_events_type_idx ON billing_events (event_type, received_at);

-- Counters for limit-based features. No professional names, credentials or other personal data.
CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  entitlement_key text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  quantity bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, entitlement_key, period_start)
);

-- Founding-customer pricing and approved discounts. Applied through a Stripe coupon at checkout; created only by an audited admin action.
CREATE TABLE billing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plan_id uuid REFERENCES subscription_plans(id),     -- NULL = any plan of the organization's type
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  discount_value integer NOT NULL CHECK (discount_value > 0),   -- whole percent (1-100), or minor currency units
  duration text NOT NULL CHECK (duration IN ('once', 'repeating', 'forever')),
  duration_months integer CHECK (duration_months BETWEEN 1 AND 36),
  stripe_coupon_id text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  reason_code text NOT NULL CHECK (reason_code IN ('founding_customer', 'promotion', 'contract', 'service_recovery')),
  created_by uuid NOT NULL REFERENCES users(id),
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'percent' OR discount_value <= 100),
  CHECK ((duration = 'repeating') = (duration_months IS NOT NULL))
);
CREATE INDEX billing_adjustments_org_idx ON billing_adjustments (organization_id, created_at DESC);

-- Initial commercial assumptions (ASSUMPTIONS.md #67). They are ordinary rows: staff change them in the admin app, not in code.
-- Annual rows start inactive because the annual discount is a business decision; Stripe price ids are attached by staff.
INSERT INTO subscription_plans (code, tier, name, customer_type, description, billing_interval, price_amount, sort_order, is_active, is_public) VALUES
  ('facility_starter_month',      'starter',      'Starter',      'facility', 'For smaller facilities.',                              'month', 29900,  10, true,  true),
  ('facility_starter_year',       'starter',      'Starter',      'facility', 'For smaller facilities.',                              'year',  299000, 10, false, true),
  ('facility_professional_month', 'professional', 'Professional', 'facility', 'For facilities with recurring workforce needs.',     'month', 79900,  20, true,  true),
  ('facility_professional_year',  'professional', 'Professional', 'facility', 'For facilities with recurring workforce needs.',     'year',  799000, 20, false, true),
  ('facility_enterprise_month',   'enterprise',   'Enterprise',   'facility', 'For multi-location healthcare organizations.',       'month', 150000, 30, true,  true),
  ('facility_enterprise_year',    'enterprise',   'Enterprise',   'facility', 'For multi-location healthcare organizations.',       'year',  1500000, 30, false, true),
  ('agency_basic_month',          'basic',        'Agency Basic', 'agency',   'For small staffing agencies.',                       'month', 49900,  10, true,  true),
  ('agency_basic_year',           'basic',        'Agency Basic', 'agency',   'For small staffing agencies.',                       'year',  499000, 10, false, true),
  ('agency_growth_month',         'growth',       'Agency Growth','agency',   'For growing staffing agencies.',                     'month', 129900, 20, true,  true),
  ('agency_growth_year',          'growth',       'Agency Growth','agency',   'For growing staffing agencies.',                     'year',  1299000, 20, false, true);

INSERT INTO plan_entitlements (plan_id, entitlement_key, value_type, value)
SELECT p.id, e.key, e.vt, e.val::jsonb
  FROM subscription_plans p
  JOIN (VALUES
    ('facility', 'starter',      'matching.enabled',             'boolean', 'true'),
    ('facility', 'starter',      'talent_search.enabled',        'boolean', 'true'),
    ('facility', 'starter',      'talent_search.monthly_limit',  'integer', '50'),
    ('facility', 'starter',      'active_locations.limit',       'integer', '1'),
    ('facility', 'starter',      'workforce_analytics.enabled',  'boolean', 'true'),
    ('facility', 'starter',      'workforce_analytics.level',    'string',  '"basic"'),
    ('facility', 'starter',      'priority_support.enabled',     'boolean', 'false'),
    ('facility', 'starter',      'api_access.enabled',           'boolean', 'false'),
    ('facility', 'professional', 'matching.enabled',             'boolean', 'true'),
    ('facility', 'professional', 'talent_search.enabled',        'boolean', 'true'),
    ('facility', 'professional', 'talent_search.monthly_limit',  'integer', '250'),
    ('facility', 'professional', 'active_locations.limit',       'integer', '5'),
    ('facility', 'professional', 'workforce_analytics.enabled',  'boolean', 'true'),
    ('facility', 'professional', 'workforce_analytics.level',    'string',  '"advanced"'),
    ('facility', 'professional', 'priority_support.enabled',     'boolean', 'true'),
    ('facility', 'professional', 'api_access.enabled',           'boolean', 'false'),
    ('facility', 'enterprise',   'matching.enabled',             'boolean', 'true'),
    ('facility', 'enterprise',   'talent_search.enabled',        'boolean', 'true'),
    ('facility', 'enterprise',   'talent_search.monthly_limit',  'integer', 'null'),
    ('facility', 'enterprise',   'active_locations.limit',       'integer', 'null'),
    ('facility', 'enterprise',   'workforce_analytics.enabled',  'boolean', 'true'),
    ('facility', 'enterprise',   'workforce_analytics.level',    'string',  '"advanced"'),
    ('facility', 'enterprise',   'priority_support.enabled',     'boolean', 'true'),
    ('facility', 'enterprise',   'api_access.enabled',           'boolean', 'true'),
    ('agency',   'basic',        'agency_roster.limit',          'integer', '25'),
    ('agency',   'basic',        'agency_submissions.monthly_limit', 'integer', '50'),
    ('agency',   'basic',        'workforce_analytics.enabled',  'boolean', 'true'),
    ('agency',   'basic',        'workforce_analytics.level',    'string',  '"basic"'),
    ('agency',   'basic',        'priority_support.enabled',     'boolean', 'false'),
    ('agency',   'growth',       'agency_roster.limit',          'integer', '150'),
    ('agency',   'growth',       'agency_submissions.monthly_limit', 'integer', '300'),
    ('agency',   'growth',       'workforce_analytics.enabled',  'boolean', 'true'),
    ('agency',   'growth',       'workforce_analytics.level',    'string',  '"advanced"'),
    ('agency',   'growth',       'priority_support.enabled',     'boolean', 'true')
  ) AS e(customer_type, tier, key, vt, val) ON e.customer_type = p.customer_type AND e.tier = p.tier;
