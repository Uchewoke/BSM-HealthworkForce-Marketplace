-- Match runs: a facility asks for a ranked shortlist for a job before (or without) anyone applying.
--
-- The run is advisory. It records who asked, which rule/ranking/weight versions produced it, and each candidate's
-- eligibility outcome, score and explanation. It never changes an application; people act through the existing
-- invitation, review, offer and acceptance flows, which re-check eligibility at that moment.
--
-- Results reuse candidate_matches (no parallel results table). A run result has no application yet, so
-- application_id becomes optional; every row must still belong to an application or to a run.

CREATE TABLE match_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('applicants','talent','both')),
  shift_ids uuid[] NOT NULL DEFAULT '{}',
  requested_by uuid NOT NULL REFERENCES users(id),
  rules_version text NOT NULL,
  ranking_version text NOT NULL,
  weights_version integer NOT NULL,
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  truncated boolean NOT NULL DEFAULT false,         -- more candidates existed than the run evaluates
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id)
);
CREATE INDEX match_runs_job_idx ON match_runs (job_id, created_at DESC);
CREATE INDEX match_runs_org_idx ON match_runs (organization_id, created_at DESC);

ALTER TABLE candidate_matches ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE candidate_matches ADD COLUMN run_id uuid;
ALTER TABLE candidate_matches ADD COLUMN source text CHECK (source IN ('applicant','talent'));
ALTER TABLE candidate_matches ADD COLUMN rank integer;                -- position among eligible candidates in the run
ALTER TABLE candidate_matches ADD FOREIGN KEY (run_id, organization_id) REFERENCES match_runs (id, organization_id);
ALTER TABLE candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_trigger_check;
ALTER TABLE candidate_matches ADD CONSTRAINT candidate_matches_trigger_check CHECK (trigger IN ('apply','offer','accept','recommend'));
ALTER TABLE candidate_matches ADD CONSTRAINT candidate_matches_owner_check CHECK (application_id IS NOT NULL OR run_id IS NOT NULL);
ALTER TABLE candidate_matches ADD CONSTRAINT candidate_matches_run_trigger_check CHECK ((trigger = 'recommend') = (run_id IS NOT NULL));
CREATE INDEX candidate_matches_run_idx ON candidate_matches (run_id, rank);

-- Stored results are a record of what was shown; they must not be edited afterwards (deletes still cascade from account removal).
CREATE FUNCTION match_records_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'match records are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER match_runs_no_update BEFORE UPDATE ON match_runs FOR EACH ROW EXECUTE FUNCTION match_records_immutable();
CREATE TRIGGER candidate_matches_no_update BEFORE UPDATE ON candidate_matches FOR EACH ROW EXECUTE FUNCTION match_records_immutable();
