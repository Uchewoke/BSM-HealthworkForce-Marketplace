-- Phase 2: timesheets. The professional records the hours actually worked for a confirmed assignment; the facility
-- approves them or returns them for correction. Only approved timesheets can be invoiced (see 0010).

CREATE TABLE timesheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  assignment_id uuid NOT NULL UNIQUE,
  professional_id uuid NOT NULL REFERENCES professionals(id),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'returned', 'approved')),
  worked_start timestamptz NOT NULL,
  worked_end timestamptz NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 480),
  minutes_worked integer NOT NULL CHECK (minutes_worked > 0 AND minutes_worked <= 1440),   -- end - start - break
  note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (assignment_id, organization_id) REFERENCES assignments (id, organization_id),
  CHECK (worked_end > worked_start)
);
CREATE INDEX timesheets_org_idx ON timesheets (organization_id, status, submitted_at DESC);
CREATE INDEX timesheets_professional_idx ON timesheets (professional_id, status);

-- Every submission and decision is kept, so a returned-then-corrected timesheet shows its whole trail.
CREATE TABLE timesheet_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timesheet_id uuid NOT NULL REFERENCES timesheets(id),
  actor_user_id uuid REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('professional', 'organization')),
  action text NOT NULL CHECK (action IN ('submitted', 'resubmitted', 'returned', 'approved')),
  worked_start timestamptz,
  worked_end timestamptz,
  break_minutes integer,
  minutes_worked integer,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timesheet_events_idx ON timesheet_events (timesheet_id, seq);
