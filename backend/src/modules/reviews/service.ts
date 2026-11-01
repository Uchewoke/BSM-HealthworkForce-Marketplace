import type { Queryable } from '../../db/index.js';

/** Days after a timesheet is approved during which either side may leave a review. */
export const REVIEW_WINDOW_DAYS = 14;
/** Aggregates are shown to other people only once there are at least this many visible reviews. */
export const MIN_PUBLIC_RATINGS = 3;
/** A professional cancelling closer than this to the shift start counts as a late cancellation. */
export const LATE_CANCEL_HOURS = 48;

/**
 * Double-blind visibility. A review is visible to people other than its author once the counterpart review exists or
 * the window has closed. Expects aliases `r` (reviews) and `t` (the assignment's approved timesheet).
 */
export const VISIBLE_SQL = `(
  EXISTS (SELECT 1 FROM reviews o WHERE o.assignment_id = r.assignment_id AND o.id <> r.id)
  OR now() > t.reviewed_at + interval '${REVIEW_WINDOW_DAYS} days')`;

export interface RatingSummary { count: number; average: number | null; shown: boolean }

const summarize = (row: { n: string; avg: string | null } | undefined, forSelf: boolean): RatingSummary => {
  const count = Number(row?.n ?? 0);
  const shown = forSelf ? count > 0 : count >= MIN_PUBLIC_RATINGS;
  return { count, average: shown && row?.avg != null ? Math.round(Number(row.avg) * 10) / 10 : null, shown };
};

/** Average of visible, non-removed reviews ABOUT a professional. Others only see it from MIN_PUBLIC_RATINGS reviews. */
export async function professionalRating(q: Queryable, professionalId: string, forSelf = false): Promise<RatingSummary> {
  const [row] = await q.query<{ n: string; avg: string | null }>(
    `SELECT count(*) AS n, avg(r.rating) AS avg FROM reviews r JOIN timesheets t ON t.assignment_id = r.assignment_id AND t.status = 'approved'
      WHERE r.professional_id = $1 AND r.direction = 'facility_to_professional' AND r.status = 'published' AND ${VISIBLE_SQL}`, [professionalId]);
  return summarize(row, forSelf);
}

/** Average of visible, non-removed reviews ABOUT an organization, written by professionals. */
export async function organizationRating(q: Queryable, organizationId: string, forSelf = false): Promise<RatingSummary> {
  const [row] = await q.query<{ n: string; avg: string | null }>(
    `SELECT count(*) AS n, avg(r.rating) AS avg FROM reviews r JOIN timesheets t ON t.assignment_id = r.assignment_id AND t.status = 'approved'
      WHERE r.organization_id = $1 AND r.direction = 'professional_to_facility' AND r.status = 'published' AND ${VISIBLE_SQL}`, [organizationId]);
  return summarize(row, forSelf);
}

/**
 * Reliability is computed from what actually happened to assignments, not from opinions. It is context for a human
 * reader and is never used by eligibility or ranking.
 */
export async function reliability(q: Queryable, professionalId: string) {
  const [row] = await q.query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE a.status = 'completed') AS completed,
            count(*) FILTER (WHERE a.status = 'no_show') AS no_shows,
            count(*) FILTER (WHERE a.status = 'cancelled_by_professional' AND a.undone_at IS NULL) AS cancellations,
            count(*) FILTER (WHERE a.status = 'cancelled_by_professional' AND a.undone_at IS NULL AND EXISTS (
              SELECT 1 FROM assignment_status_history h WHERE h.assignment_id = a.id AND h.to_status = 'cancelled_by_professional'
                AND h.created_at > s.starts_at - interval '${LATE_CANCEL_HOURS} hours')) AS late_cancellations
       FROM assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.professional_id = $1`, [professionalId]);
  const completed = Number(row?.completed ?? 0), noShows = Number(row?.no_shows ?? 0), cancellations = Number(row?.cancellations ?? 0);
  const lateCancellations = Number(row?.late_cancellations ?? 0);
  const considered = completed + noShows + cancellations;
  return {
    completedShifts: completed, noShows, cancellations, lateCancellations,
    completionRate: considered === 0 ? null : Math.round((completed / considered) * 100),
    sampleSize: considered,
  };
}
