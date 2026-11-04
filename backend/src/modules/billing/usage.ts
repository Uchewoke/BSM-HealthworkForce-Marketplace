import type { RequestHandler } from 'express';
import type { Queryable } from '../../db/index.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { billingCtx, ENTITLEMENT_KEYS, getOrganizationEntitlements, limitFor, requireEntitlement, type EffectiveEntitlements, type EntitlementKey } from './entitlements.js';

export interface UsageReservation { organizationId: string; key: string; quantity: number; periodStart: Date }

/**
 * Atomically adds to a usage counter, refusing if the plan limit would be exceeded. This is ONE statement: concurrent requests queue on the
 * row lock, so two of them can never both squeeze under the limit. Returns null when the limit would be exceeded.
 */
export async function reserveUsage(q: Queryable, e: EffectiveEntitlements, organizationId: string, key: EntitlementKey, quantity: number): Promise<UsageReservation | null> {
  const limit = limitFor(e, key);
  if (limit !== null && quantity > limit) return null; // the first insert has no row to compare against
  const [row] = await q.query<{ quantity: string }>(
    `INSERT INTO usage_records (organization_id, entitlement_key, period_start, period_end, quantity) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, entitlement_key, period_start)
     DO UPDATE SET quantity = usage_records.quantity + EXCLUDED.quantity, updated_at = now()
       WHERE $6::bigint IS NULL OR usage_records.quantity + EXCLUDED.quantity <= $6::bigint
     RETURNING quantity`, [organizationId, key, e.periodStart, e.periodEnd, quantity, limit]);
  return row ? { organizationId, key, quantity, periodStart: e.periodStart } : null;
}

/** Gives a reservation back when the operation it paid for failed. */
export async function releaseUsage(q: Queryable, r: UsageReservation): Promise<void> {
  await q.query(
    `UPDATE usage_records SET quantity = GREATEST(quantity - $4, 0), updated_at = now() WHERE organization_id = $1 AND entitlement_key = $2 AND period_start = $3`,
    [r.organizationId, r.key, r.periodStart, r.quantity]);
}

/** Records usage without a limit check (for example after the fact, or for organizations that are not gated). */
export async function recordUsage(q: Queryable, e: EffectiveEntitlements, organizationId: string, key: EntitlementKey, quantity: number): Promise<void> {
  await q.query(
    `INSERT INTO usage_records (organization_id, entitlement_key, period_start, period_end, quantity) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, entitlement_key, period_start) DO UPDATE SET quantity = usage_records.quantity + EXCLUDED.quantity, updated_at = now()`,
    [organizationId, key, e.periodStart, e.periodEnd, quantity]);
}

/** Checks the limit, reserves, runs the operation, and gives the reservation back if the operation throws. */
export async function withUsage<T>(deps: AppDeps, organizationId: string, key: EntitlementKey, quantity: number, fn: () => Promise<T>): Promise<T> {
  const e = await getOrganizationEntitlements(deps.db, organizationId, billingCtx(deps));
  requireEntitlement(e, key);
  const r = await reserveUsage(deps.db, e, organizationId, key, quantity);
  if (!r) throw limitError(e, key);
  try { return await fn(); } catch (err) { await releaseUsage(deps.db, r); throw err; }
}

function limitError(e: EffectiveEntitlements, key: EntitlementKey) {
  return new AppError('FORBIDDEN', 'Your plan limit for this month has been reached. Upgrade your plan to continue.',
    { code: 'USAGE_LIMIT_EXCEEDED', entitlement: key, limit: limitFor(e, key), upgradeRequired: true, resetsAt: e.periodEnd.toISOString() });
}

/**
 * Route middleware (after requireOrgPermission): requires the feature and reserves usage before the handler runs. If the response ends with
 * an error status the reservation is returned, so rejected or failed requests do not eat into the allowance.
 */
export const meterUsageMw = (deps: AppDeps, key: EntitlementKey, quantity = 1): RequestHandler => async (req, res, next) => {
  try {
    const orgId = req.membership!.organizationId;
    const e = await getOrganizationEntitlements(deps.db, orgId, billingCtx(deps));
    requireEntitlement(e, key);
    const r = await reserveUsage(deps.db, e, orgId, key, quantity);
    if (!r) throw limitError(e, key);
    res.on('finish', () => { if (res.statusCode >= 400) void releaseUsage(deps.db, r).catch(() => undefined); });
    res.on('close', () => { if (!res.writableFinished) void releaseUsage(deps.db, r).catch(() => undefined); });
    next();
  } catch (err) { next(err); }
};

/** Live counters for features limited by how many exist right now rather than by a monthly count. */
const LIVE_COUNTS: Partial<Record<EntitlementKey, string>> = {
  'active_locations.limit': 'SELECT count(*) AS n FROM facility_locations WHERE organization_id = $1 AND active',
  'agency_roster.limit': `SELECT count(*) AS n FROM agency_roster WHERE agency_id = $1 AND status IN ('invited','active')`,
};

/** Usage against every numeric limit in the plan. Exempt organizations see their consumption with no limit. */
export async function usageSummary(q: Queryable, organizationId: string, e: EffectiveEntitlements) {
  const metered = await q.query<{ entitlement_key: string; quantity: string }>(
    'SELECT entitlement_key, quantity FROM usage_records WHERE organization_id = $1 AND period_start = $2', [organizationId, e.periodStart]);
  const used = new Map(metered.map((m) => [m.entitlement_key, Number(m.quantity)]));
  const out: { key: string; used: number; limit: number | null; kind: 'monthly' | 'current' }[] = [];
  const keys = e.enforced ? Object.keys(e.values).filter((k) => (ENTITLEMENT_KEYS as Record<string, string>)[k] === 'integer') : [];
  for (const key of keys) {
    const sql = LIVE_COUNTS[key as EntitlementKey];
    const live = sql ? Number((await q.query<{ n: string }>(sql, [organizationId]))[0]?.n ?? 0) : null;
    out.push({ key, used: live ?? used.get(key) ?? 0, limit: limitFor(e, key as EntitlementKey), kind: sql ? 'current' : 'monthly' });
  }
  return { periodStart: e.periodStart, periodEnd: e.periodEnd, usage: out };
}
