-- Jobs, job requirements, shifts and job status history.

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  department_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  profession_id uuid NOT NULL REFERENCES professions(id),
  specialty_id uuid REFERENCES specialties(id),
  employment_type text NOT NULL CHECK (employment_type IN ('permanent','per_diem','contract','travel')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','paused','filled','closed','cancelled')),
  pay_unit text NOT NULL DEFAULT 'hour' CHECK (pay_unit IN ('hour','year')),
  pay_min_cents integer CHECK (pay_min_cents BETWEEN 0 AND 2000000000),
  pay_max_cents integer CHECK (pay_max_cents BETWEEN 0 AND 2000000000),
  application_deadline timestamptz,
  positions_count integer NOT NULL DEFAULT 1 CHECK (positions_count BETWEEN 1 AND 500),
  min_years_experience integer CHECK (min_years_experience BETWEEN 0 AND 50),
  -- The facility explicitly states the role has no mandatory license/certification requirement.
  no_credential_requirements boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES facility_locations (id, organization_id),
  FOREIGN KEY (department_id, organization_id) REFERENCES departments (id, organization_id),
  CHECK (pay_min_cents IS NULL OR pay_max_cents IS NULL OR pay_min_cents <= pay_max_cents)
);
CREATE INDEX jobs_org_status_idx ON jobs (organization_id, status);
CREATE INDEX jobs_published_idx ON jobs (published_at DESC) WHERE status = 'published';
CREATE INDEX jobs_profession_idx ON jobs (profession_id) WHERE status = 'published';
CREATE INDEX jobs_location_idx ON jobs (location_id);

-- Mandatory requirements are inputs to the Milestone 5 eligibility engine; preferred ones (mandatory = false) are informational.
CREATE TABLE job_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('license','certification','other')),
  credential_type text,               -- e.g. RN, BLS (matches credentials.credential_type)
  jurisdiction text CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  description text,
  mandatory boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id) ON DELETE CASCADE,
  CHECK (kind = 'other' OR credential_type IS NOT NULL),
  CHECK (kind <> 'license' OR jurisdiction IS NOT NULL),
  CHECK (kind <> 'other' OR description IS NOT NULL)
);
CREATE INDEX job_requirements_job_idx ON job_requirements (job_id);
CREATE UNIQUE INDEX job_requirements_unique_idx
  ON job_requirements (job_id, kind, lower(coalesce(credential_type, '')), coalesce(jurisdiction, ''), coalesce(description, ''));

-- Shifts are scheduled occurrences of a non-permanent job; they inherit the job's requirements.
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  positions integer NOT NULL DEFAULT 1 CHECK (positions BETWEEN 1 AND 100),
  hourly_rate_cents integer CHECK (hourly_rate_cents BETWEEN 0 AND 100000),
  notes text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id) ON DELETE CASCADE,
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '24 hours')
);
CREATE INDEX shifts_job_idx ON shifts (job_id, starts_at);
CREATE INDEX shifts_open_idx ON shifts (starts_at) WHERE status = 'open';

CREATE TABLE job_events (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  from_status text,
  to_status text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, seq);
