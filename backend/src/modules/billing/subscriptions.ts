import type { Queryable } from '../../db/index.js';
import type { ProviderSubscription } from '../../integrations/billing.js';

export const LOCAL_STATUSES = ['incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'] as const;
export type LocalStatus = (typeof LOCAL_STATUSES)[number];

/** Provider status -> local status. Unknown values are treated as 'incomplete' (no access) rather than guessed at. */
export function mapProviderStatus(s: string): LocalStatus {
  switch (s) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due': return 'past_due';
    case 'unpaid': return 'unpaid';
    case 'canceled': case 'incomplete_expired': return 'canceled';
    case 'paused': return 'paused';
    default: return 'incomplete';
  }
}

/** Statuses in which the organization already has a subscription it must manage rather than buy again. */
export const LIVE_STATUSES: readonly LocalStatus[] = ['trialing', 'active', 'past_due', 'unpaid', 'paused'];

/** A problem with an event that is not the event's fault, so redelivery after a fix can succeed. The code is stored; the message is not. */
export class BillingSyncError extends Error {
  constructor(readonly code: string, readonly retryable = true) { super(code); }
}

export type Ordering = { kind: 'event'; created: Date } | { kind: 'authoritative' };

export interface SyncResult {
  outcome: 'applied' | 'stale' | 'ignored';
  organizationId?: string;
  previousStatus?: LocalStatus | null;
  status?: LocalStatus;
  planCode?: string;
}

/**
 * Writes one provider subscription into the local projection.
 * - The organization comes from OUR customer mapping, never from the payload alone; metadata that disagrees with it is rejected.
 * - Events older than the newest one already applied are ignored, so out-of-order delivery cannot roll the state back.
 * - Another live subscription for the same organization is rejected rather than silently replaced.
 * Call inside a transaction: it locks the organization's subscription row.
 */
export async function applyProviderSubscription(q: Queryable, sub: ProviderSubscription, order: Ordering, graceDays: number): Promise<SyncResult> {
  const [customer] = await q.query<{ organization_id: string }>(
    `SELECT organization_id FROM billing_customers WHERE provider = 'stripe' AND provider_customer_id = $1`, [sub.customerId]);
  if (!customer) return { outcome: 'ignored' }; // not one of ours
  const organizationId = customer.organization_id;
  if (sub.organizationId && sub.organizationId !== organizationId) throw new BillingSyncError('organization_mismatch', false);

  const [org] = await q.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
  const [plan] = sub.priceId ? await q.query<{ id: string; code: string; customer_type: string; price_amount: string; billing_interval: string }>(
    'SELECT id, code, customer_type, price_amount, billing_interval FROM subscription_plans WHERE stripe_price_id = $1', [sub.priceId]) : [];
  if (!plan) throw new BillingSyncError('unknown_price');
  if (!org || plan.customer_type !== org.type) throw new BillingSyncError('plan_type_mismatch', false);

  const status = mapProviderStatus(sub.status);
  const [existing] = await q.query<{ stripe_subscription_id: string; status: LocalStatus; last_event_created: Date; grace_period_end: Date | null }>(
    'SELECT stripe_subscription_id, status, last_event_created, grace_period_end FROM organization_subscriptions WHERE organization_id = $1 FOR UPDATE', [organizationId]);

  const sameSub = existing?.stripe_subscription_id === sub.id;
  if (existing && !sameSub) {
    if (status === 'canceled' || status === 'incomplete') return { outcome: 'stale', organizationId }; // an old or abandoned subscription ended
    if (LIVE_STATUSES.includes(existing.status)) throw new BillingSyncError('duplicate_subscription'); // needs a person to decide which to keep
  }
  if (sameSub && order.kind === 'event' && order.created < existing.last_event_created) return { outcome: 'stale', organizationId };

  const eventTime = order.kind === 'event' ? order.created : (existing?.last_event_created ?? new Date());
  // A payment failure starts the grace period once; later failures and replays do not extend it.
  const grace = status === 'past_due'
    ? (sameSub && existing.status === 'past_due' && existing.grace_period_end ? existing.grace_period_end : new Date(eventTime.getTime() + graceDays * 86_400_000))
    : null;
  const lastEvent = sameSub && order.kind === 'authoritative' ? existing.last_event_created : eventTime;

  await q.query(
    `INSERT INTO organization_subscriptions (organization_id, plan_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, unit_amount_minor,
        current_period_start, current_period_end, trial_start, trial_end, cancel_at_period_end, canceled_at, grace_period_end, last_event_created)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (organization_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id, status = EXCLUDED.status, billing_interval = EXCLUDED.billing_interval,
        unit_amount_minor = EXCLUDED.unit_amount_minor, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
        trial_start = EXCLUDED.trial_start, trial_end = EXCLUDED.trial_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        canceled_at = EXCLUDED.canceled_at, grace_period_end = EXCLUDED.grace_period_end, last_event_created = EXCLUDED.last_event_created, updated_at = now()`,
    [organizationId, plan.id, sub.customerId, sub.id, status, sub.interval ?? plan.billing_interval, sub.unitAmount ?? Number(plan.price_amount),
     sub.currentPeriodStart, sub.currentPeriodEnd, sub.trialStart, sub.trialEnd, sub.cancelAtPeriodEnd, sub.canceledAt, grace, lastEvent]);

  if (sub.couponId && (status === 'active' || status === 'trialing')) {
    await q.query('UPDATE billing_adjustments SET consumed_at = now() WHERE organization_id = $1 AND stripe_coupon_id = $2 AND consumed_at IS NULL', [organizationId, sub.couponId]);
  }
  return { outcome: 'applied', organizationId, previousStatus: sameSub ? existing.status : null, status, planCode: plan.code };
}

/** What the organization's own billing contacts see. Provider identifiers are not included. */
export async function loadSubscriptionView(q: Queryable, organizationId: string) {
  const [row] = await q.query<Record<string, any>>(
    `SELECT s.status, s.billing_interval, s.unit_amount_minor, s.current_period_start, s.current_period_end, s.trial_start, s.trial_end,
            s.cancel_at_period_end, s.canceled_at, s.grace_period_end, p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.currency
       FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.organization_id = $1`, [organizationId]);
  return row ?? null;
}
