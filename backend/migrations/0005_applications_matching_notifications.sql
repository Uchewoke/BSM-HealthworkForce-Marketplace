-- Applications, stored eligibility/ranking snapshots, notifications, platform settings.

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  organization_id uuid NOT NULL,                  -- the job's organization; every facility query is scoped by it
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted','under_review','shortlisted','interview_requested','interviewed','offer_sent',
    'accepted','declined','withdrawn','rejected','cancelled')),
  cover_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (job_id, professional_id),
  FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id)
);
CREATE INDEX applications_org_status_idx ON applications (organization_id, status, created_at);
CREATE INDEX applications_job_idx ON applications (job_id);
CREATE INDEX applications_professional_idx ON applications (professional_id, created_at DESC);

CREATE TABLE application_shifts (
  application_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  PRIMARY KEY (application_id, shift_id),
  FOREIGN KEY (application_id, organization_id) REFERENCES applications (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id)
);
CREATE INDEX application_shifts_shift_idx ON application_shifts (shift_id);

CREATE TABLE application_events (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('professional','organization')),
  from_status text,
  to_status text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_events_app_idx ON application_events (application_id, seq);

-- Point-in-time eligibility + ranking result, written at decision points (apply, offer, accept) so it can be reviewed later.
CREATE TABLE candidate_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  professional_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('apply','offer','accept')),
  outcome text NOT NULL CHECK (outcome IN ('eligible','ineligible','pending_verification','needs_review','unavailable','expired_credential')),
  eligibility jsonb NOT NULL,
  score numeric(5,2),                             -- only set for eligible candidates
  explanation jsonb,
  rules_version text NOT NULL,
  weights_version integer NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidate_matches_app_idx ON candidate_matches (application_id, evaluated_at);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('application_updates','review_decisions')),
  type text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  email_status text NOT NULL DEFAULT 'skipped' CHECK (email_status IN ('skipped','not_delivered','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('application_updates','review_decisions')),
  email_enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
