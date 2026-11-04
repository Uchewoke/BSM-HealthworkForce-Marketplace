import type { Queryable } from '../../db/index.js';

/**
 * Subscription metrics, all in integer minor units (cents). Definitions (also published to staff by GET /admin/billing/metrics):
 * - MRR: for subscriptions that are `active` or `past_due`, the billed price per interval normalised to one month (annual / 12), BEFORE coupons.
 *   Trials, unpaid, paused and cancelled subscriptions and one-time fees are excluded.
 * - ARR: MRR x 12.
 * - Active paying organizations: distinct organizations with an `active` or `past_due` subscription whose billed price is above zero.
 * - Trial conversion: of subscriptions whose trial ended inside the window, the share now paying (or cancelled only after the trial ended).
 * - Churn: subscriptions cancelled inside the window / subscriptions that existed at the start of the window and had not already ended.
 * - Failed payment rate: invoice.payment_failed / (invoice.payment_failed + invoice.paid) events processed inside the window.
 * - Gross subscription revenue: the sum of invoice.paid amounts inside the window. It is billings collected, not profit and not recognised revenue.
 * Refunds and credits are not tracked in this milestone and are reported as null.
 */
export const METRIC_DEFINITIONS = {
  mrr: 'Active and past-due subscriptions, annual prices divided by 12, before coupons. Trials and one-time fees excluded.',
  arr: 'MRR x 12.',
  activePayingOrganizations: 'Distinct organizations with an active or past-due subscription billed above zero.',
  trialConversion: 'Of trials that ended in the window, the share now paying (or cancelled only after the trial ended).',
  churnRate: 'Subscriptions cancelled in the window / subscriptions that existed at the start of the window and had not already ended.',
  failedPaymentRate: 'Failed invoice payments / (failed + paid) in the window.',
  grossSubscriptionRevenue: 'Sum of paid subscription invoices in the window. Billings collected: not profit and not recognised revenue.',
  refundsAndCredits: 'Not tracked in this milestone.',
} as const;

const MONTHLY = `CASE WHEN s.billing_interval = 'year' THEN round(s.unit_amount_minor / 12.0) ELSE s.unit_amount_minor END`;

export async function subscriptionMetrics(q: Queryable, from: Date, to: Date) {
  const one = async <T>(sql: string, args: unknown[] = []) => (await q.query<T>(sql, args))[0]!;
  const totals = await one<{ mrr: string; paying: string; active: string; past_due: string; trials: string }>(
    `SELECT coalesce(sum(CASE WHEN s.status IN ('active','past_due') THEN ${MONTHLY} END), 0) AS mrr,
            count(DISTINCT CASE WHEN s.status IN ('active','past_due') AND s.unit_amount_minor > 0 THEN s.organization_id END) AS paying,
            count(*) FILTER (WHERE s.status = 'active') AS active,
            count(*) FILTER (WHERE s.status = 'past_due') AS past_due,
            count(*) FILTER (WHERE s.status = 'trialing') AS trials
       FROM organization_subscriptions s`);
  const byPlan = await q.query<{ code: string; name: string; customer_type: string; subscriptions: string; mrr: string }>(
    `SELECT p.code, p.name, p.customer_type, count(*) AS subscriptions, coalesce(sum(CASE WHEN s.status IN ('active','past_due') THEN ${MONTHLY} END), 0) AS mrr
       FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.status IN ('trialing','active','past_due') GROUP BY p.code, p.name, p.customer_type, p.sort_order ORDER BY p.customer_type, p.sort_order, p.code`);
  const byType = await q.query<{ type: string; mrr: string; paying: string }>(
    `SELECT o.type, coalesce(sum(${MONTHLY}), 0) AS mrr, count(DISTINCT s.organization_id) FILTER (WHERE s.unit_amount_minor > 0) AS paying
       FROM organization_subscriptions s JOIN organizations o ON o.id = s.organization_id WHERE s.status IN ('active','past_due') GROUP BY o.type ORDER BY o.type`);
  const trial = await one<{ ended: string; converted: string }>(
    `SELECT count(*) AS ended,
            count(*) FILTER (WHERE s.status IN ('active','past_due','unpaid') OR (s.status = 'canceled' AND s.canceled_at > s.trial_end)) AS converted
       FROM organization_subscriptions s WHERE s.trial_end >= $1 AND s.trial_end < $2`, [from, to]);
  const churn = await one<{ start_count: string; lost: string }>(
    `SELECT count(*) FILTER (WHERE s.created_at < $1 AND (s.status <> 'canceled' OR s.canceled_at IS NULL OR s.canceled_at >= $1)) AS start_count,
            count(*) FILTER (WHERE s.status = 'canceled' AND s.canceled_at >= $1 AND s.canceled_at < $2) AS lost
       FROM organization_subscriptions s`, [from, to]);
  const payments = await one<{ paid: string; failed: string; gross: string }>(
    `SELECT count(*) FILTER (WHERE event_type = 'invoice.paid') AS paid, count(*) FILTER (WHERE event_type = 'invoice.payment_failed') AS failed,
            coalesce(sum(amount_minor) FILTER (WHERE event_type = 'invoice.paid'), 0) AS gross
       FROM billing_events WHERE processing_status = 'processed' AND received_at >= $1 AND received_at < $2`, [from, to]);
  const grossByType = await q.query<{ type: string; gross: string }>(
    `SELECT o.type, coalesce(sum(e.amount_minor), 0) AS gross FROM billing_events e JOIN organizations o ON o.id = e.organization_id
      WHERE e.event_type = 'invoice.paid' AND e.processing_status = 'processed' AND e.received_at >= $1 AND e.received_at < $2 GROUP BY o.type ORDER BY o.type`, [from, to]);

  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);
  const mrr = Number(totals.mrr);
  const paying = Number(totals.paying);
  return {
    window: { from, to },
    currency: 'USD',
    mrrMinor: mrr,
    arrMinor: mrr * 12,
    activePayingOrganizations: paying,
    activeSubscriptions: Number(totals.active),
    pastDueSubscriptions: Number(totals.past_due),
    trialOrganizations: Number(totals.trials),
    averageRevenuePerOrganizationMinor: paying > 0 ? Math.round(mrr / paying) : null,
    trialConversionRate: ratio(Number(trial.converted), Number(trial.ended)),
    trialsEnded: Number(trial.ended),
    churnRate: ratio(Number(churn.lost), Number(churn.start_count)),
    churnedSubscriptions: Number(churn.lost),
    failedPaymentRate: ratio(Number(payments.failed), Number(payments.failed) + Number(payments.paid)),
    grossSubscriptionRevenueMinor: Number(payments.gross),
    refundsAndCreditsMinor: null as number | null,
    planDistribution: byPlan.map((p) => ({ code: p.code, name: p.name, customerType: p.customer_type, subscriptions: Number(p.subscriptions), mrrMinor: Number(p.mrr) })),
    byCustomerType: byType.map((t) => ({
      customerType: t.type, mrrMinor: Number(t.mrr), payingOrganizations: Number(t.paying),
      grossSubscriptionRevenueMinor: Number(grossByType.find((g) => g.type === t.type)?.gross ?? 0),
    })),
    definitions: METRIC_DEFINITIONS,
  };
}
