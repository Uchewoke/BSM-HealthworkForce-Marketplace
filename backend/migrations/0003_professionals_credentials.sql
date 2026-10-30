-- Professionals, taxonomy, credentials, private documents, credential review history.

CREATE TABLE professions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE specialties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profession_id uuid NOT NULL REFERENCES professions(id),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX specialties_profession_name_uq ON specialties (profession_id, lower(name));

-- PLACEHOLDER reference data so the app is usable in development. The launch list is an open product decision
-- (ASSUMPTIONS.md #4); platform admins can change it through the taxonomy endpoints.
INSERT INTO professions (code, name) VALUES
  ('rn', 'Registered Nurse'), ('lpn', 'Licensed Practical / Vocational Nurse'), ('cna', 'Certified Nursing Assistant'),
  ('np', 'Nurse Practitioner'), ('pt', 'Physical Therapist'), ('rt', 'Respiratory Therapist');
INSERT INTO specialties (profession_id, name)
  SELECT p.id, s.name FROM professions p JOIN (VALUES
    ('rn','Medical-Surgical'),('rn','Critical Care / ICU'),('rn','Emergency'),('rn','Perioperative'),
    ('rn','Pediatrics'),('rn','Labor & Delivery'),('rn','Telemetry'),('rn','Long-Term Care'),
    ('lpn','Long-Term Care'),('lpn','Home Health'),('cna','Long-Term Care'),('cna','Acute Care'),
    ('np','Family Practice'),('np','Acute Care'),('pt','Outpatient'),('pt','Acute Care'),('rt','Critical Care / ICU')
  ) AS s(code, name) ON s.code = p.code;

CREATE TABLE professionals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  profession_id uuid NOT NULL REFERENCES professions(id),
  headline text,
  summary text,
  phone text,
  city text,
  state text CHECK (state ~ '^[A-Z]{2}$'),
  -- Account standing only. Profile completeness and credential status are computed separately; nothing here means "verified".
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','restricted','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE professional_specialties (
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  specialty_id uuid NOT NULL REFERENCES specialties(id),
  PRIMARY KEY (professional_id, specialty_id)
);

CREATE TABLE professional_education (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  institution text NOT NULL,
  degree text NOT NULL,
  field_of_study text,
  start_year integer CHECK (start_year BETWEEN 1940 AND 2100),
  end_year integer CHECK (end_year BETWEEN 1940 AND 2100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_year IS NULL OR start_year IS NULL OR end_year >= start_year)
);
CREATE INDEX professional_education_prof_idx ON professional_education (professional_id);

CREATE TABLE professional_experience (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  employer text NOT NULL,
  title text NOT NULL,
  specialty_id uuid REFERENCES specialties(id),
  city text,
  state text CHECK (state ~ '^[A-Z]{2}$'),
  start_date date NOT NULL,
  end_date date,
  is_current boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (NOT is_current OR end_date IS NULL)
);
CREATE INDEX professional_experience_prof_idx ON professional_experience (professional_id);

CREATE TABLE professional_preferences (
  professional_id uuid PRIMARY KEY REFERENCES professionals(id) ON DELETE CASCADE,
  employment_types text[] NOT NULL DEFAULT '{}',
  shift_types text[] NOT NULL DEFAULT '{}',
  preferred_states text[] NOT NULL DEFAULT '{}',   -- work-location preference (states)
  max_travel_miles integer CHECK (max_travel_miles BETWEEN 0 AND 3000),
  min_hourly_rate_cents integer CHECK (min_hourly_rate_cents BETWEEN 0 AND 100000),
  available_from date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Recurring weekly windows. end_time < start_time means the window runs overnight into the next day.
CREATE TABLE professional_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  CHECK (start_time <> end_time)
);
CREATE INDEX professional_availability_prof_idx ON professional_availability (professional_id);

-- Licenses and certifications share one table (kind) so documents, review history and the review queue are uniform.
CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('license','certification')),
  credential_type text NOT NULL,                 -- e.g. RN, BLS
  jurisdiction text CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  issuing_authority text,
  number_enc text,                               -- AES-256-GCM; full number never returned to the professional
  number_last4 text,
  issue_date date,
  expiration_date date,
  status text NOT NULL DEFAULT 'not_submitted' CHECK (status IN (
    'not_submitted','submitted','pending_review','verification_in_progress','verified','rejected',
    'expired','needs_more_information','revoked','unable_to_verify')),
  verification_method text CHECK (verification_method IN ('document_review','primary_source')),
  verification_reference text,                   -- required when method = primary_source
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, professional_id),
  CHECK (kind <> 'license' OR jurisdiction IS NOT NULL),
  CHECK (expiration_date IS NULL OR issue_date IS NULL OR expiration_date >= issue_date),
  CHECK (status <> 'verified' OR verification_method IS NOT NULL)
);
CREATE INDEX credentials_professional_idx ON credentials (professional_id);
CREATE INDEX credentials_status_idx ON credentials (status, updated_at);

CREATE TABLE credential_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL,
  professional_id uuid NOT NULL,
  storage_key uuid NOT NULL UNIQUE,              -- server-generated; the file lives in private object storage
  original_name text NOT NULL,                   -- sanitized display name only; never used as a path
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  scan_status text NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned','clean')),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (credential_id, professional_id) REFERENCES credentials (id, professional_id) ON DELETE CASCADE
);
CREATE INDEX credential_documents_credential_idx ON credential_documents (credential_id);

-- Full history of submissions and review decisions.
CREATE TABLE credential_verifications (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('professional','platform')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  method text CHECK (method IN ('document_review','primary_source')),
  source_reference text,
  reason text,          -- visible to the professional
  internal_note text,   -- platform reviewers only
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credential_verifications_cred_idx ON credential_verifications (credential_id, seq);
