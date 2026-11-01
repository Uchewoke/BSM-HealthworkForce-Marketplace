import { Router } from 'express';
import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { requireOrgPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { forecastDemand, type ForecastResult } from './model.js';

const orgParams = z.object({ orgId: z.uuid() });
const query = z.object({ horizon: z.coerce.number().int().min(4).max(12).default(8) });
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MAX_HISTORY_WEEKS = 104;
const MAX_PROFESSIONS = 5;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Monday 00:00 UTC of the week containing `ms`, matching date_trunc('week') on UTC dates. */
const mondayOf = (ms: number) => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY; };

interface Weekly { wk: string; n: string }

function seriesFrom(rows: Weekly[], startMs: number, endMs: number): { week: string; positions: number }[] {
  const byWeek = new Map(rows.map((r) => [r.wk, Number(r.n)]));
  const out: { week: string; positions: number }[] = [];
  for (let t = startMs; t <= endMs; t += WEEK) out.push({ week: ymd(t), positions: byWeek.get(ymd(t)) ?? 0 });
  return out;
}

function shape(result: ForecastResult, history: { week: string; positions: number }[], thisMonday: number, posted: Map<string, number>, fillRate: number | null) {
  if (result.status !== 'ok') return { status: result.status, reason: result.reason, history };
  return {
    status: 'ok' as const, method: result.method, confidence: result.confidence, backtest: result.backtest, weeksOfHistory: result.weeksOfHistory, history,
    forecast: result.points.map((p) => {
      const week = ymd(thisMonday + (p.week - 1) * WEEK);
      const alreadyPosted = posted.get(week) ?? 0;
      // Demand already posted is a floor: the forecast can never say fewer positions than are already open.
      const expected = Math.max(p.mean, alreadyPosted);
      return {
        week, expected: Math.round(expected * 10) / 10, low: Math.max(p.low, alreadyPosted), high: Math.max(p.high, alreadyPosted), alreadyPosted,
        expectedUnfilled: fillRate === null ? null : Math.round(expected * (1 - fillRate) * 10) / 10,
      };
    }),
  };
}

/** Demand forecast from an organization's own shift history. Aggregates only. */
export async function loadForecast(q: Queryable, orgId: string, horizon: number, nowMs: number) {
  const thisMonday = mondayOf(nowMs);
  const lastComplete = thisMonday - WEEK;
  const [first] = await q.query<{ first: Date | null }>(`SELECT min(starts_at) AS first FROM shifts WHERE organization_id = $1 AND status <> 'cancelled'`, [orgId]);
  const startMs = first?.first ? Math.max(mondayOf(new Date(first.first).getTime()), thisMonday - MAX_HISTORY_WEEKS * WEEK) : lastComplete + WEEK;
  const startDate = ymd(startMs);
  const weekSql = `to_char(date_trunc('week', s.starts_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

  const overallRows = await q.query<Weekly>(
    `SELECT ${weekSql} AS wk, sum(s.positions) AS n FROM shifts s WHERE s.organization_id = $1 AND s.status <> 'cancelled' AND s.starts_at >= $2::date GROUP BY 1`, [orgId, startDate]);
  const posted = new Map(overallRows.filter((r) => r.wk >= ymd(thisMonday)).map((r) => [r.wk, Number(r.n)]));
  const history = startMs <= lastComplete ? seriesFrom(overallRows, startMs, lastComplete) : [];

  // How much of recent demand actually got filled: turns "expected positions" into "expected unfilled".
  const [fill] = await q.query<{ posted: string; filled: string }>(
    `SELECT coalesce(sum(s.positions), 0) AS posted,
            (SELECT count(*) FROM assignments a JOIN shifts s2 ON s2.id = a.shift_id WHERE s2.organization_id = $1 AND s2.status <> 'cancelled'
               AND a.status IN ('confirmed','completed') AND s2.starts_at >= $2::date AND s2.starts_at < $3::date) AS filled
       FROM shifts s WHERE s.organization_id = $1 AND s.status <> 'cancelled' AND s.starts_at >= $2::date AND s.starts_at < $3::date`,
    [orgId, ymd(lastComplete - 11 * WEEK), ymd(thisMonday)]);
  const fillRate = Number(fill?.posted ?? 0) >= 10 ? Math.min(1, Number(fill?.filled ?? 0) / Number(fill!.posted)) : null;

  const overall = shape(forecastDemand(history.map((h) => h.positions), horizon), history, thisMonday, posted, fillRate);

  const profRows = await q.query<{ pid: string; name: string; wk: string; n: string }>(
    `SELECT pr.id AS pid, pr.name, ${weekSql} AS wk, sum(s.positions) AS n FROM shifts s JOIN jobs j ON j.id = s.job_id JOIN professions pr ON pr.id = j.profession_id
      WHERE s.organization_id = $1 AND s.status <> 'cancelled' AND s.starts_at >= $2::date GROUP BY pr.id, pr.name, 3`, [orgId, startDate]);
  const groups = new Map<string, { name: string; rows: Weekly[] }>();
  for (const r of profRows) { const g = groups.get(r.pid) ?? { name: r.name, rows: [] }; g.rows.push({ wk: r.wk, n: r.n }); groups.set(r.pid, g); }
  const byProfession = [...groups.values()]
    .map((g) => ({ ...g, total: g.rows.reduce((s, r) => s + Number(r.n), 0) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, MAX_PROFESSIONS)
    .map((g) => {
      const h = startMs <= lastComplete ? seriesFrom(g.rows, startMs, lastComplete) : [];
      const postedP = new Map(g.rows.filter((r) => r.wk >= ymd(thisMonday)).map((r) => [r.wk, Number(r.n)]));
      return { profession: g.name, ...shape(forecastDemand(h.map((x) => x.positions), horizon), h, thisMonday, postedP, null) };
    });

  return { generatedAt: new Date(nowMs).toISOString(), horizonWeeks: horizon, currentWeek: ymd(thisMonday), recentFillRate: fillRate === null ? null : Math.round(fillRate * 1000) / 10, overall, byProfession };
}

/** Mounted at /organizations/:orgId/forecast. */
export function forecastRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  r.get('/', validate({ params: orgParams }), requireOrgPermission(deps, 'jobs.read'), async (req, res) => {
    const { horizon } = query.parse(req.query);
    res.json(await loadForecast(db, req.membership!.organizationId, horizon, now()));
  });
  return r;
}
