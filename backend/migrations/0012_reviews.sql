-- Phase 2: verified reviews and disputes. A review is tied to one completed assignment that has an approved timesheet,
-- so it cannot be written about work that never happened. Ratings never feed eligibility or ranking.

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  direction text NOT NULL CHECK (direction IN ('facility_to_professional', 'professional_to_facility')),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  professional_id uuid NOT NULL REFERENCES professionals(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (char_length(comment) <= 1500),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, direction)
);
CREATE INDEX reviews_professional_idx ON reviews (professional_id, direction) WHERE status = 'published';
CREATE INDEX reviews_org_idx ON reviews (organization_id, direction) WHERE status = 'published';

-- One dispute per review. A review stays visible and counted while its dispute is open; staff decide the outcome.
CREATE TABLE review_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL UNIQUE REFERENCES reviews(id),
  raised_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'removed')),
  resolved_by uuid REFERENCES users(id),
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_disputes_status_idx ON review_disputes (status, created_at);
