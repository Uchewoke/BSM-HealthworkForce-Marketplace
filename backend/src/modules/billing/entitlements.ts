import type { RequestHandler } from 'express';
import type { Queryable } from '../../db/index.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';

/** Every entitlement key the product recognises, with its value type. Admin plan edits are validated against this list. */
export const ENTITLEMENT_KEYS = {
  'matching.enabled': 'boolean',
  'talent_search.enabled': 'boolean',
  'talent_search.monthly_limit': 'integer',
  'active_locations.limit': 'integer',
  'workforce_analytics.enabled': 'boolean',
  'workforce_analytics.level': 'string',
  'priority_support.enabled': 'boolean',
  'api_access.enabled': 'boolean',
  'agency_roster.limit': 'integer',
  'agency_submissions.monthly_limit': 'integer',
} as const satisfies Record<string, 'boolean' | 'integer' | 'string'>;
export type EntitlementKey = keyof typeof ENTITLEMENT_KEYS;

export type EntitlementValue = boolean | number | string | null;

/** Days of tolerance after a billing period ends, so a renewal webhook that is a little late does not lock a paying customer out. */
export const RENEWAL_SLACK_MS = 3 * 86_400_000;

export interface SubscriptionRow {
  id: string; organization_id: string; plan_id: string; status: string; billing_interval: string;
  current_period_start: Date | null; current_period_end: Date | null; trial_end: Date | null;
  cancel_at_period_end: boolean; canceled_at: Date | null; grace_period_end: Date | null;
}

export type DenyReason = 'no_subscription' | 'incomplete' | 'unpaid' | 'canceled' | 'paused' | 'expired' | 'past_due_grace_ended' | 'not_in_plan';
export interface AccessDecision { allowed: boolean; state: 'active' | 'trial' | 'grace' | 'restricted'; reason?: DenyReason }

/**
 * Whether a subscription currently carries paid features. Pure, so the lifecycle rules can be tested without a database.
 * - active / trialing: yes (a lapsed period past the renewal tolerance counts as expired)
 * - past_due: yes only inside the grace period; the paid features stop when it ends
 * - canceled at period end: stays 'active' until the period ends, then loses access on that date (no tolerance)
 * - unpaid, incomplete, paused, canceled: no
 */
export function decideAccess(sub: Pick<SubscriptionRow, 'status' | 'current_period_end' | 'trial_end' | 'cancel_at_period_end' | 'grace_period_end'> | null, now: Date): AccessDecision {
  if (!sub) return { allowed: false, state: 'restricted', reason: 'no_subscription' };
  const t = now.getTime();
  switch (sub.status) {
    case 'trialing': {
      const end = sub.trial_end?.getTime();
      return end !== undefined && t > end + RENEWAL_SLACK_MS ? { allowed: false, state: 'restricted', reason: 'expired' } : { allowed: true, state: 'trial' };
    }
    case 'active': {
      const end = sub.current_period_end?.getTime();
      const tolerance = sub.cancel_at_period_end ? 0 : RENEWAL_SLACK_MS;
      return end !== undefined && t > end + tolerance ? { allowed: false, state: 'restricted', reason: 'expired' } : { allowed: true, state: 'active' };
    }
    case 'past_due':
      return sub.grace_period_end && t <= sub.grace_period_end.getTime()
        ? { allowed: true, state: 'grace' } : { allowed: false, state: 'restricted', reason: 'past_due_grace_ended' };
    case 'unpaid': return { allowed: false, state: 'restricted', reason: 'unpaid' };
    case 'canceled': return { allowed: false, state: 'restricted', reason: 'canceled' };
    case 'paused': return { allowed: false, state: 'restricted', reason: 'paused' };
    default: return { allowed: false, state: 'restricted', reason: 'incomplete' };
  }
}

export interface BillingCtx { enabled: boolean; graceDays: number; now: Date }
export const billingCtx = (deps: Pick<AppDeps, 'config' | 'now'>): BillingCtx => ({ enabled: deps.config.billingEnabled, graceDays: deps.config.billingGraceDays, now: new Date((deps.now ?? Date.now)()) });

export interface EffectiveEntitlements {
  /** True when this organization's paid features are gated. False for 'exempt' organizations and whenever the master switch is off. */
  enforced: boolean;
  access: AccessDecision | { allowed: true; state: 'exempt' };
  plan: { id: string; code: string; name: string; billingInterval: string } | null;
  subscription: SubscriptionRow | null;
  /** Empty when access is restricted. */
  values: Record<string, { type: string; value: EntitlementValue }>;
  periodStart: Date;
  periodEnd: Date;
}

/** The usage period: the subscription's current billing period when one is in force, otherwise the UTC calendar month. */
export function usagePeriod(sub: Pick<SubscriptionRow, 'current_period_start' | 'current_period_end'> | null, now: Date) {
  if (sub?.current_period_start && sub.current_period_end && now >= sub.current_period_start && now < sub.current_period_end) {
    return { start: sub.current_period_start, end: sub.current_period_end };
  }
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

/** The single place that answers "what may this organization use right now". Always organization-scoped. */
export async function getOrganizationEntitlements(q: Queryable, organizationId: string, ctx: BillingCtx): Promise<EffectiveEntitlements> {
  const [org] = await q.query<{ billing_mode: string }>('SELECT billing_mode FROM organizations WHERE id = $1', [organizationId]);
  if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
  const [sub] = await q.query<SubscriptionRow>(
    `SELECT id, organization_id, plan_id, status, billing_interval, current_period_start, current_period_end, trial_end,
            cancel_at_period_end, canceled_at, grace_period_end FROM organization_subscriptions WHERE organization_id = $1`, [organizationId]);
  const [plan] = sub ? await q.query<{ id: string; code: string; name: string; billing_interval: string }>(
    'SELECT id, code, name, billing_interval FROM subscription_plans WHERE id = $1', [sub.plan_id]) : [];
  const period = usagePeriod(sub ?? null, ctx.now);
  const base = {
    plan: plan ? { id: plan.id, code: plan.code, name: plan.name, billingInterval: plan.billing_interval } : null,
    subscription: sub ?? null, periodStart: period.start, periodEnd: period.end,
  };
  if (!ctx.enabled || org.billing_mode !== 'enforced') return { ...base, enforced: false, access: { allowed: true, state: 'exempt' }, values: {} };
  const access = decideAccess(sub ?? null, ctx.now);
  if (!access.allowed || !sub) return { ...base, enforced: true, access, values: {} };
  const rows = await q.query<{ entitlement_key: string; value_type: string; value: EntitlementValue }>(
    'SELECT entitlement_key, value_type, value FROM plan_entitlements WHERE plan_id = $1', [sub.plan_id]);
  return { ...base, enforced: true, access, values: Object.fromEntries(rows.map((r) => [r.entitlement_key, { type: r.value_type, value: r.value }])) };
}

function deny(key: string, reason: DenyReason | string, message: string): never {
  throw new AppError('FORBIDDEN', message, { code: 'ENTITLEMENT_REQUIRED', entitlement: key, reason, upgradeRequired: true });
}

const DENY_MESSAGE: Record<string, string> = {
  no_subscription: 'This feature needs an active subscription.',
  not_in_plan: 'This feature is not included in your current plan.',
  past_due_grace_ended: 'Your payment is overdue and the grace period has ended. Update your payment method to restore this feature.',
  unpaid: 'Your subscription is unpaid. Update your payment method to restore this feature.',
};
const denyMessage = (reason: string) => DENY_MESSAGE[reason] ?? 'Your subscription does not currently include this feature.';

/** Throws unless the feature is available. Exempt organizations always pass. */
export function requireEntitlement(e: EffectiveEntitlements, key: EntitlementKey): void {
  if (!e.enforced) return;
  if (!e.access.allowed) return deny(key, (e.access as AccessDecision).reason ?? 'no_subscription', denyMessage((e.access as AccessDecision).reason ?? 'no_subscription'));
  const v = e.values[key];
  if (!v || v.value === false) return deny(key, 'not_in_plan', denyMessage('not_in_plan'));
}

/** The numeric limit for a feature: a number, or null for unlimited (also for exempt organizations). A feature missing from the plan has limit 0. */
export function limitFor(e: EffectiveEntitlements, key: EntitlementKey): number | null {
  if (!e.enforced) return null;
  const v = e.values[key];
  if (!v || !e.access.allowed) return 0;
  return typeof v.value === 'number' ? v.value : null;
}

/** Route middleware (run after requireOrgPermission): blocks the request unless the organization's plan includes the feature. */
export const requireEntitlementMw = (deps: AppDeps, key: EntitlementKey): RequestHandler => async (req, _res, next) => {
  try {
    requireEntitlement(await getOrganizationEntitlements(deps.db, req.membership!.organizationId, billingCtx(deps)), key);
    next();
  } catch (e) { next(e); }
};

/** For count-based limits (locations, roster size): throws if one more would exceed the limit. Call inside the transaction that inserts. */
export async function assertWithinCountLimit(deps: AppDeps, q: Queryable, organizationId: string, key: EntitlementKey, currentCount: number): Promise<void> {
  const e = await getOrganizationEntitlements(q, organizationId, billingCtx(deps));
  requireEntitlement(e, key);
  const limit = limitFor(e, key);
  if (limit !== null && currentCount + 1 > limit) {
    throw new AppError('FORBIDDEN', 'Your plan limit has been reached. Upgrade your plan to add more.', { code: 'USAGE_LIMIT_EXCEEDED', entitlement: key, limit, used: currentCount, upgradeRequired: true });
  }
}
