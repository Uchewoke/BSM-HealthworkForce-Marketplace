import { Router, type Request } from 'express';
import { orgRoleCan } from '@bsm/permissions';
import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { requireOrgPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';

const orgParams = z.object({ orgId: z.uuid() });
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const rangeQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });

const num = (v: unknown) => (v == null ? 0 : Number(v));
const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface Range { from: string; to: string; days: number; bucket: 'week' | 'month'; keys: string[] }

/**
 * The reporting window, in UTC calendar days and inclusive of both ends. Defaults to the last 90 days.
 * Up to ~4 months is shown by week, longer by month, so charts stay readable.
 */
export function resolveRange(q: { from?: string; to?: string }, nowMs: number): Range {
  const toDate = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(`${ymd(new Date(nowMs))}T00:00:00Z`);
  const fromDate = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(toDate.getTime() - 89 * DAY_MS);
  const days = Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
  if (days < 1) throw new AppError('VALIDATION_FAILED', 'The end date must be on or after the start date.', { fieldErrors: { to: ['Must be on or after the start date.'] } });
  if (days > MAX_RANGE_DAYS) throw new AppError('VALIDATION_FAILED', `Choose a period of at most ${MAX_RANGE_DAYS} days.`, { fieldErrors: { from: ['Period too long.'] } });
  const bucket = days <= 120 ? 'week' : 'month';
  const keys: string[] = [];
  if (bucket === 'week') {
    const start = new Date(fromDate);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); // back to Monday, matching date_trunc('week')
    for (let d = start; d <= toDate; d = new Date(d.getTime() + 7 * DAY_MS)) keys.push(ymd(d));
  } else {
    for (let d = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1)); d <= toDate; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) keys.push(ymd(d));
  }
  return { from: ymd(fromDate), to: ymd(toDate), days, bucket, keys };
}

const bucketSql = (b: Range['bucket'], col: string) => `to_char(date_trunc('${b}', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

/** Facility staffing analytics. Aggregates only: no individual professional is identifiable in any figure. */
export async function facilityAnalytics(q: Queryable, orgId: string, range: Range, includeCosts: boolean) {
  const args = [orgId, range.from, `${range.to}T23:59:59.999Z`];
  const shiftsIn = `s.organization_id = $1 AND s.status <> 'cancelled' AND s.starts_at >= $2::date AND s.starts_at <= $3::timestamptz`;
  const FILLED = `a.status IN ('confirmed','completed')`;

  const posted = await q.query<{ bucket: string; positions: string }>(
    `SELECT ${bucketSql(range.bucket, 's.starts_at')} AS bucket, sum(s.positions) AS positions FROM shifts s WHERE ${shiftsIn} GROUP BY 1`, args);
  const filled = await q.query<{ bucket: string; filled: string }>(
    `SELECT ${bucketSql(range.bucket, 's.starts_at')} AS bucket, count(*) AS filled FROM assignments a JOIN shifts s ON s.id = a.shift_id WHERE ${shiftsIn} AND ${FILLED} GROUP BY 1`, args);
  const applications = await q.query<{ bucket: string; applications: string }>(
    `SELECT ${bucketSql(range.bucket, 'a.created_at')} AS bucket, count(*) AS applications FROM applications a
      WHERE a.organization_id = $1 AND a.created_at >= $2::date AND a.created_at <= $3::timestamptz GROUP BY 1`, args);

  const trend = range.keys.map((key) => ({
    bucket: key,
    positionsPosted: num(posted.find((r) => r.bucket === key)?.positions),
    positionsFilled: num(filled.find((r) => r.bucket === key)?.filled),
    applications: num(applications.find((r) => r.bucket === key)?.applications),
  }));
  const positionsPosted = trend.reduce((s, t) => s + t.positionsPosted, 0);
  const positionsFilled = trend.reduce((s, t) => s + t.positionsFilled, 0);

  const byProfession = (await q.query<{ name: string; posted: string; filled: string }>(
    `SELECT pr.name, sum(s.positions) AS posted,
            (SELECT count(*) FROM assignments a JOIN shifts s2 ON s2.id = a.shift_id JOIN jobs j2 ON j2.id = s2.job_id
              WHERE j2.profession_id = pr.id AND s2.organization_id = $1 AND s2.status <> 'cancelled' AND s2.starts_at >= $2::date AND s2.starts_at <= $3::timestamptz AND ${FILLED}) AS filled
       FROM shifts s JOIN jobs j ON j.id = s.job_id JOIN professions pr ON pr.id = j.profession_id WHERE ${shiftsIn} GROUP BY pr.id, pr.name ORDER BY sum(s.positions) DESC, pr.name`, args))
    .map((r) => ({ profession: r.name, positionsPosted: num(r.posted), positionsFilled: num(r.filled), fillRate: pct(num(r.filled), num(r.posted)) }));

  const outcomeRows = await q.query<{ status: string; n: string }>(
    `SELECT a.status, count(*) AS n FROM assignments a JOIN shifts s ON s.id = a.shift_id WHERE ${shiftsIn} GROUP BY a.status`, args);
  const outcomeCount = (st: string) => num(outcomeRows.find((r) => r.status === st)?.n);
  const outcomes = {
    confirmed: outcomeCount('confirmed'), completed: outcomeCount('completed'), noShow: outcomeCount('no_show'),
    cancelledByProfessional: outcomeCount('cancelled_by_professional'), cancelledByFacility: outcomeCount('cancelled_by_facility'),
  };
  const finished = outcomes.completed + outcomes.noShow + outcomes.cancelledByProfessional + outcomes.cancelledByFacility;

  const [ttf] = await q.query<{ median_hours: string | null; n: string }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (a.created_at - j.published_at)) / 3600) AS median_hours, count(*) AS n
       FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id
      WHERE a.organization_id = $1 AND j.published_at IS NOT NULL AND a.created_at >= $2::date AND a.created_at <= $3::timestamptz AND a.created_at >= j.published_at`, args);

  const [offers] = await q.query<Record<string, string>>(
    `SELECT count(*) AS sent, count(*) FILTER (WHERE status = 'accepted') AS accepted, count(*) FILTER (WHERE status = 'declined') AS declined, count(*) FILTER (WHERE status = 'expired') AS expired
       FROM shift_offers WHERE organization_id = $1 AND created_at >= $2::date AND created_at <= $3::timestamptz`, args);
  const [apps] = await q.query<Record<string, string>>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE submitted_by_agency_id IS NOT NULL) AS via_agency FROM applications
      WHERE organization_id = $1 AND created_at >= $2::date AND created_at <= $3::timestamptz`, args);
  const [upcoming] = await q.query<{ open: string }>(
    `SELECT coalesce(sum(s.positions) - (SELECT count(*) FROM assignments a JOIN shifts s2 ON s2.id = a.shift_id WHERE s2.organization_id = $1 AND s2.starts_at > now() AND s2.status <> 'cancelled' AND ${FILLED}), 0) AS open
       FROM shifts s WHERE s.organization_id = $1 AND s.starts_at > now() AND s.status <> 'cancelled'`, [orgId]);

  const result: Record<string, unknown> = {
    range: { from: range.from, to: range.to, days: range.days, bucket: range.bucket },
    fill: { positionsPosted, positionsFilled, fillRate: pct(positionsFilled, positionsPosted), upcomingOpenPositions: Math.max(0, num(upcoming?.open)) },
    trend, byProfession, outcomes: { ...outcomes, finished, noShowRate: pct(outcomes.noShow, finished), cancellationRate: pct(outcomes.cancelledByProfessional + outcomes.cancelledByFacility, finished), completionRate: pct(outcomes.completed, finished) },
    timeToFill: { medianHours: ttf?.median_hours == null ? null : Math.round(Number(ttf.median_hours) * 10) / 10, sample: num(ttf?.n) },
    funnel: { applications: num(apps?.total), viaAgency: num(apps?.via_agency), offersSent: num(offers?.sent), offersAccepted: num(offers?.accepted), offersDeclined: num(offers?.declined), offersExpired: num(offers?.expired), offerAcceptanceRate: pct(num(offers?.accepted), num(offers?.sent)) },
  };

  if (includeCosts) {
    // Staffing cost is the agreed pay for approved hours (a facility pays professionals directly), plus BSM's platform fee.
    const costRows = await q.query<{ bucket: string; minutes: string; pay: string }>(
      `SELECT ${bucketSql(range.bucket, 't.worked_end')} AS bucket, sum(t.minutes_worked) AS minutes, sum(round(t.minutes_worked * a.hourly_rate_cents / 60.0)) AS pay
         FROM timesheets t JOIN assignments a ON a.id = t.assignment_id
        WHERE t.organization_id = $1 AND t.status = 'approved' AND t.worked_end >= $2::date AND t.worked_end <= $3::timestamptz GROUP BY 1`, args);
    const costTrend = range.keys.map((key) => {
      const row = costRows.find((r) => r.bucket === key);
      return { bucket: key, hours: Math.round((num(row?.minutes) / 60) * 100) / 100, payCents: num(row?.pay) };
    });
    const hours = costTrend.reduce((s, t) => s + t.hours, 0);
    const payCents = costTrend.reduce((s, t) => s + t.payCents, 0);
    const byProfessionCost = (await q.query<{ name: string; minutes: string; pay: string }>(
      `SELECT pr.name, sum(t.minutes_worked) AS minutes, sum(round(t.minutes_worked * a.hourly_rate_cents / 60.0)) AS pay
         FROM timesheets t JOIN assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id JOIN professions pr ON pr.id = j.profession_id
        WHERE t.organization_id = $1 AND t.status = 'approved' AND t.worked_end >= $2::date AND t.worked_end <= $3::timestamptz GROUP BY pr.name ORDER BY sum(round(t.minutes_worked * a.hourly_rate_cents / 60.0)) DESC`, args))
      .map((r) => ({ profession: r.name, hours: Math.round((num(r.minutes) / 60) * 100) / 100, payCents: num(r.pay) }));
    const [fees] = await q.query<{ invoiced: string; paid: string }>(
      `SELECT coalesce(sum(total_cents) FILTER (WHERE status IN ('issued','paid')), 0) AS invoiced, coalesce(sum(total_cents) FILTER (WHERE status = 'paid'), 0) AS paid
         FROM invoices WHERE organization_id = $1 AND issued_at >= $2::date AND issued_at <= $3::timestamptz`, args);
    result.costs = {
      approvedHours: Math.round(hours * 100) / 100, agreedPayCents: payCents, averageHourlyRateCents: hours === 0 ? null : Math.round(payCents / hours),
      platformFeesInvoicedCents: num(fees?.invoiced), platformFeesPaidCents: num(fees?.paid), trend: costTrend, byProfession: byProfessionCost,
    };
  }
  return result;
}

/** Agency analytics: what the agency submitted and what came of it. */
export async function agencyAnalytics(q: Queryable, agencyId: string, range: Range) {
  const args = [agencyId, range.from, `${range.to}T23:59:59.999Z`];
  const win = `a.submitted_by_agency_id = $1 AND a.created_at >= $2::date AND a.created_at <= $3::timestamptz`;
  const byStatus = await q.query<{ status: string; n: string }>(`SELECT a.status, count(*) AS n FROM applications a WHERE ${win} GROUP BY a.status`, args);
  const submissionsBucket = await q.query<{ bucket: string; submissions: string }>(
    `SELECT ${bucketSql(range.bucket, 'a.created_at')} AS bucket, count(*) AS submissions FROM applications a WHERE ${win} GROUP BY 1`, args);
  const placementsBucket = await q.query<{ bucket: string; placements: string }>(
    `SELECT ${bucketSql(range.bucket, 'asg.created_at')} AS bucket, count(*) AS placements
       FROM assignments asg JOIN shift_offers so ON so.id = asg.offer_id JOIN applications a ON a.id = so.application_id
      WHERE a.submitted_by_agency_id = $1 AND asg.created_at >= $2::date AND asg.created_at <= $3::timestamptz GROUP BY 1`, args);
  const trend = range.keys.map((key) => ({
    bucket: key, submissions: num(submissionsBucket.find((r) => r.bucket === key)?.submissions), placements: num(placementsBucket.find((r) => r.bucket === key)?.placements),
  }));
  const submissions = trend.reduce((s, t) => s + t.submissions, 0);
  const placements = trend.reduce((s, t) => s + t.placements, 0);
  const byFacility = (await q.query<{ name: string; submissions: string; placements: string }>(
    `SELECT fo.name, count(DISTINCT a.id) AS submissions, count(DISTINCT asg.id) AS placements
       FROM applications a JOIN organizations fo ON fo.id = a.organization_id
       LEFT JOIN shift_offers so ON so.application_id = a.id LEFT JOIN assignments asg ON asg.offer_id = so.id
      WHERE ${win} GROUP BY fo.id, fo.name ORDER BY count(DISTINCT a.id) DESC, fo.name LIMIT 10`, args))
    .map((r) => ({ facility: r.name, submissions: num(r.submissions), placements: num(r.placements) }));
  const [hours] = await q.query<{ minutes: string }>(
    `SELECT coalesce(sum(t.minutes_worked), 0) AS minutes FROM timesheets t JOIN assignments asg ON asg.id = t.assignment_id JOIN shift_offers so ON so.id = asg.offer_id
       JOIN applications a ON a.id = so.application_id WHERE a.submitted_by_agency_id = $1 AND t.status = 'approved' AND t.worked_end >= $2::date AND t.worked_end <= $3::timestamptz`, args);
  const statusCount = (st: string) => num(byStatus.find((r) => r.status === st)?.n);
  return {
    range: { from: range.from, to: range.to, days: range.days, bucket: range.bucket },
    totals: { submissions, placements, placementRate: pct(placements, submissions), approvedHours: Math.round((num(hours?.minutes) / 60) * 100) / 100, rejected: statusCount('rejected'), withdrawn: statusCount('withdrawn') },
    byStatus: byStatus.map((r) => ({ status: r.status, count: num(r.n) })).sort((a, b) => b.count - a.count),
    trend, byFacility,
  };
}

/** Facility analytics, mounted at /organizations/:orgId/analytics. */
export function facilityAnalyticsRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  r.get('/', validate({ params: orgParams }), requireOrgPermission(deps, 'jobs.read'), async (req: Request, res) => {
    const range = resolveRange(rangeQuery.parse(req.query), now());
    // Cost figures are billing information: only roles with billing.read receive them.
    const includeCosts = orgRoleCan(req.membership!.role, 'billing.read');
    res.json({ ...(await facilityAnalytics(db, req.membership!.organizationId, range, includeCosts)), includesCosts: includeCosts });
  });
  return r;
}

/** Agency analytics, mounted at /organizations/:orgId/agency/analytics. */
export function agencyAnalyticsRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  r.get('/', validate({ params: orgParams }), requireOrgPermission(deps, 'agency.submissions.read'), async (req: Request, res) => {
    const [o] = await db.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1', [req.membership!.organizationId]);
    if (o?.type !== 'agency') throw new AppError('NOT_FOUND', 'Resource not found.');
    const range = resolveRange(rangeQuery.parse(req.query), now());
    res.json(await agencyAnalytics(db, req.membership!.organizationId, range));
  });
  return r;
}
