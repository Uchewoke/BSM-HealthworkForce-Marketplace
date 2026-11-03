-- Retention and erasure support for match runs (ADR 0009).
--
-- match_run_holds: the smallest safe legal hold. A held run (and its results) is skipped by retention cleanup and by professional
--   erasure until the hold is released. Kept in its own table so match_runs stays update-protected. The foreign key also makes it
--   impossible to delete a held run even if application code were wrong, and a trigger does the same for the run's results.
-- retention_runs: history of cleanup and erasure executions. Counts and status only: never names, emails, credential
--   numbers or the professional an erasure concerned.
-- The retention period itself lives in platform_settings under the key 'match_retention' (default applied in code).
--
-- Locking (all locks are held until the migration commits):
--   Both tables are locked up front, in the same order the application's own transactions use (match_runs, then
--   candidate_matches). That order is what makes this safe: taking them one at a time as each statement needs them lets a
--   concurrent writer and this migration each hold one and wait for the other, and PostgreSQL then aborts one of them
--   (a rehearsal hit exactly that deadlock when the order was reversed). SHARE ROW EXCLUSIVE covers everything below, so no
--   later statement needs a stronger lock on these tables. While the migration runs, writes to those two tables WAIT (they do
--   not fail); reads continue. lock_timeout makes the migration give up cleanly, with nothing changed, if it cannot get the
--   locks in time (for example behind a long transaction); run it again when that transaction has finished.
--   The new tables' foreign keys also briefly lock users, which is why they come last.
-- Both indexes use IF NOT EXISTS so that, on very large tables, an operator can build them beforehand with
-- CREATE INDEX CONCURRENTLY (outside a transaction) under the same names and keep this migration fast.
-- See documentation/operations/match-retention-deployment.md.

SET LOCAL lock_timeout = '30s';
LOCK TABLE match_runs, candidate_matches IN SHARE ROW EXCLUSIVE MODE;

-- Erasure looks results up by professional (candidate_matches has no foreign key to professionals); retention scans runs by age.
CREATE INDEX IF NOT EXISTS candidate_matches_professional_run_idx ON candidate_matches (professional_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_runs_created_idx ON match_runs (created_at);

CREATE TABLE match_run_holds (
  run_id uuid PRIMARY KEY REFERENCES match_runs(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),   -- a reference such as a matter or ticket number, not personal data
  placed_by uuid NOT NULL REFERENCES users(id),
  placed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('match_retention','professional_erasure')),
  mode text NOT NULL CHECK (mode IN ('scheduled','manual')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  requested_by uuid REFERENCES users(id),                -- null for scheduled runs
  retention_days integer,                                -- the policy applied (cleanup only)
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,                                       -- an error class name only, never a message
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX retention_runs_started_idx ON retention_runs (started_at DESC);

-- Database-level protection for the results of a held run. The foreign key above already stops the run row itself being deleted;
-- this stops its result rows being deleted by any statement at all (cleanup, erasure, or hand-written SQL). It also locks the
-- affected runs first, so a hold being placed at the same moment waits and then sees the outcome, instead of slipping past.
-- Statement-level with a transition table: one check per DELETE statement, not per row. Cascades from applications only remove
-- decision snapshots (no run), which this ignores.
CREATE FUNCTION candidate_matches_hold_guard() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM match_runs r WHERE r.id IN (SELECT run_id FROM old_rows WHERE run_id IS NOT NULL) ORDER BY r.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM old_rows o JOIN match_run_holds h ON h.run_id = o.run_id) THEN
    RAISE EXCEPTION 'results of a held match run cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER candidate_matches_hold_guard AFTER DELETE ON candidate_matches
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION candidate_matches_hold_guard();
