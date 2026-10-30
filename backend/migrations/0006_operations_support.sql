-- Operations: per-state configuration, support tickets, support notification category.

-- A missing row means "enabled, nothing special". Disabling a state hides its jobs from search and blocks publishing there.
CREATE TABLE state_configurations (
  state text PRIMARY KEY CHECK (state ~ '^[A-Z]{2}$'),
  enabled boolean NOT NULL DEFAULT true,
  compact_member boolean,          -- informational (null = unknown); not used by eligibility yet
  notes text,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),   -- optional context; creator must be a member
  category text NOT NULL CHECK (category IN ('account','credential','job','application','dispute','other')),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_user','resolved','closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  related_type text CHECK (related_type IN ('application','job','credential','organization')),
  related_id uuid,                                      -- user-supplied reference; never auto-resolved or exposed
  assigned_to uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX support_tickets_creator_idx ON support_tickets (created_by, updated_at DESC);
CREATE INDEX support_tickets_queue_idx ON support_tickets (status, priority, created_at);

CREATE TABLE support_ticket_messages (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  author_kind text NOT NULL CHECK (author_kind IN ('user','staff')),
  internal boolean NOT NULL DEFAULT false,              -- staff-only note, never shown to the ticket owner
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT internal OR author_kind = 'staff')
);
CREATE INDEX support_ticket_messages_ticket_idx ON support_ticket_messages (ticket_id, seq);

ALTER TABLE notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('application_updates','review_decisions','support_updates'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check
  CHECK (category IN ('application_updates','review_decisions','support_updates'));
