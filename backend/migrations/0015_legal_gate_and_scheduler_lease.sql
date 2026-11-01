-- Legal sign-off gate and a lock for scheduled work.
--
-- legal_signoffs: two features depend on legal review (the shared float pool, and automatic outreach on a facility's behalf).
-- They stay switched off for everyone until a super admin records that counsel signed off: who, when, and a reference to
-- the review. Turning a feature off again is audited and withdraws what is in flight.
CREATE TABLE legal_signoffs (
  feature text PRIMARY KEY CHECK (feature IN ('float_pool', 'shift_recovery')),
  signed_off boolean NOT NULL DEFAULT false,
  reference text,                          -- e.g. the counsel memo or ticket that records the review
  note text,
  signed_off_by uuid REFERENCES users(id),
  signed_off_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO legal_signoffs (feature) VALUES ('float_pool'), ('shift_recovery');

-- scheduler_leases: lets several API servers share one scheduled job. Whoever holds an unexpired lease runs it; the lease
-- expires on its own if that server dies mid-run.
CREATE TABLE scheduler_leases (
  name text PRIMARY KEY,
  holder text NOT NULL,
  expires_at timestamptz NOT NULL
);
