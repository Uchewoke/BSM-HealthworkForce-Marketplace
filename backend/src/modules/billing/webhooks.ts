import type { RequestHandler } from 'express';
import { normalizeSubscription, WebhookSignatureError, type ProviderEvent } from '../../integrations/billing.js';
import type { AppDeps } from '../../shared/deps.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { audit } from '../audit/service.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { applyProviderSubscription, BillingSyncError, type SyncResult } from './subscriptions.js';

const formatMoney = (minor: number) => `$${(minor / 100).toFixed(2)}`;

interface Handled { status: 'processed' | 'ignored'; organizationId?: string; amountMinor?: number; currency?: string }

/** Finds our organization for a provider customer id. Unknown customers belong to someone else and are ignored. */
async function orgForCustomer(deps: AppDeps, customerId: unknown): Promise<string | null> {
  if (typeof customerId !== 'string') return null;
  const [row] = await deps.db.query<{ organization_id: string }>(
    `SELECT organization_id FROM billing_customers WHERE provider = 'stripe' AND provider_customer_id = $1`, [customerId]);
  return row?.organization_id ?? null;
}

async function syncAndAnnounce(deps: AppDeps, apply: (tx: Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0]) => Promise<SyncResult>, eventId: string): Promise<Handled> {
  const result = await deps.db.transaction(async (tx) => {
    const r = await apply(tx);
    if (r.outcome === 'applied') {
      await audit(tx, {
        action: 'billing.subscription_synced', targetType: 'organization_subscription', targetId: r.organizationId, organizationId: r.organizationId,
        metadata: { status: r.status, previousStatus: r.previousStatus ?? null, plan: r.planCode, eventId },
      });
    }
    return r;
  });
  if (result.outcome === 'ignored' || !result.organizationId) return { status: 'ignored' };
  if (result.outcome === 'applied' && result.status !== result.previousStatus) await announce(deps, result);
  return { status: result.outcome === 'applied' ? 'processed' : 'ignored', organizationId: result.organizationId };
}

/** Tells the organization's billing contacts about the changes that need their attention. */
async function announce(deps: AppDeps, r: SyncResult) {
  const titles: Partial<Record<string, [string, string]>> = {
    active: ['Your subscription is active', 'Your plan is active.'],
    trialing: ['Your trial has started', 'Your trial has started. Add payment details before it ends to keep access.'],
    past_due: ['Your payment did not go through', 'Update your payment method soon. Paid features stay available during a grace period, then pause until payment succeeds.'],
    unpaid: ['Your subscription is unpaid', 'Paid features are paused. Update your payment method to restore them.'],
    canceled: ['Your subscription has ended', 'Your data is kept. You can subscribe again at any time.'],
  };
  const t = r.status ? titles[r.status] : undefined;
  if (!t || !r.organizationId) return;
  await notifyUsers(deps, await orgUserIdsWithPermission(deps.db, r.organizationId, 'billing.read'), {
    category: 'billing_updates', type: `subscription.${r.status}`, title: t[0], body: t[1], data: { organizationId: r.organizationId },
  });
}

async function dispatch(deps: AppDeps, ev: ProviderEvent): Promise<Handled> {
  const graceDays = deps.config.billingGraceDays;
  const o = ev.object;
  switch (ev.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return syncAndAnnounce(deps, (tx) => applyProviderSubscription(tx, normalizeSubscription(o), { kind: 'event', created: ev.created }, graceDays), ev.id);

    case 'checkout.session.completed': {
      if (o.mode !== 'subscription' || typeof o.subscription !== 'string') return { status: 'ignored' };
      const orgId = await orgForCustomer(deps, o.customer);
      if (!orgId) return { status: 'ignored' };
      // The session says which organization it was created for; it must agree with who owns the customer.
      if (typeof o.client_reference_id === 'string' && o.client_reference_id !== orgId) throw new BillingSyncError('organization_mismatch', false);
      // The completed session only says a subscription exists. Its state is read from the provider, never taken from the redirect.
      const sub = await deps.billing!.retrieveSubscription(o.subscription);
      return syncAndAnnounce(deps, (tx) => applyProviderSubscription(tx, sub, { kind: 'event', created: ev.created }, graceDays), ev.id);
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const organizationId = await orgForCustomer(deps, o.customer);
      if (!organizationId) return { status: 'ignored' };
      const failed = ev.type === 'invoice.payment_failed';
      const amountMinor = Number(failed ? o.amount_due : o.amount_paid) || 0;
      const currency = typeof o.currency === 'string' ? o.currency.toUpperCase() : 'USD';
      if (failed) {
        await audit(deps.db, { action: 'billing.payment_failed', targetType: 'organization', targetId: organizationId, organizationId, metadata: { eventId: ev.id, amountMinor } });
        await notifyUsers(deps, await orgUserIdsWithPermission(deps.db, organizationId, 'billing.read'), {
          category: 'billing_updates', type: 'payment.failed', title: 'A subscription payment failed',
          body: `We could not collect ${formatMoney(amountMinor)}. Update your payment method in the billing portal.`, data: { organizationId },
        });
      }
      return { status: 'processed', organizationId, amountMinor, currency };
    }

    default:
      return { status: 'ignored' };
  }
}

/** Runs one verified event exactly once in effect. Returns the HTTP status to answer the provider with. */
export async function processBillingEvent(deps: AppDeps, ev: ProviderEvent): Promise<200 | 500> {
  const [created] = await deps.db.query<{ id: string }>(
    `INSERT INTO billing_events (provider, provider_event_id, event_type) VALUES ('stripe', $1, $2) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
    [ev.id, ev.type]);
  if (!created) {
    const [prior] = await deps.db.query<{ processing_status: string }>(`SELECT processing_status FROM billing_events WHERE provider = 'stripe' AND provider_event_id = $1`, [ev.id]);
    if (prior && (prior.processing_status === 'processed' || prior.processing_status === 'ignored')) return 200; // duplicate delivery
    await deps.db.query(`UPDATE billing_events SET attempt_count = attempt_count + 1, processing_status = 'received' WHERE provider = 'stripe' AND provider_event_id = $1`, [ev.id]);
  }
  try {
    const h = await dispatch(deps, ev);
    await deps.db.query(
      `UPDATE billing_events SET processing_status = $2, processed_at = now(), last_error_code = NULL, organization_id = $3, amount_minor = $4, currency = $5
        WHERE provider = 'stripe' AND provider_event_id = $1`, [ev.id, h.status, h.organizationId ?? null, h.amountMinor ?? null, h.currency ?? null]);
    return 200;
  } catch (e) {
    const code = e instanceof BillingSyncError ? e.code : 'processing_error';
    await deps.db.query(`UPDATE billing_events SET processing_status = 'failed', last_error_code = $2 WHERE provider = 'stripe' AND provider_event_id = $1`, [ev.id, code]);
    await audit(deps.db, { action: 'billing.event_failed', targetType: 'billing_event', targetId: ev.id, metadata: { type: ev.type, code } }).catch(() => undefined);
    // Permanent mismatches will not fix themselves, so they are not retried; everything else is, and staff can resync meanwhile.
    return e instanceof BillingSyncError && !e.retryable ? 200 : 500;
  }
}

/**
 * POST /api/v1/billing/webhooks/stripe. Mounted with a raw-body parser BEFORE the JSON parser: the signature covers the exact bytes received.
 * Nothing from the payload is logged.
 */
export const stripeWebhookHandler = (deps: AppDeps): RequestHandler => async (req, res) => {
  const provider = deps.billing;
  const reply = (status: number, code: string, message: string) => res.status(status).json({ error: { code, message, requestId: req.requestId } });
  if (!provider?.configured) return void reply(503, 'UNAVAILABLE', 'Subscription billing is not switched on.');
  if (!Buffer.isBuffer(req.body)) return void reply(400, 'BAD_REQUEST', 'Expected a raw request body.');
  let ev: ProviderEvent;
  try {
    ev = provider.verifyWebhook(req.body, req.header('stripe-signature'), (deps.now ?? Date.now)());
  } catch (e) {
    if (!(e instanceof WebhookSignatureError)) throw e;
    (deps.logger ?? defaultLogger).warn({ requestId: req.requestId }, 'billing webhook rejected: signature did not verify');
    return void reply(400, 'BAD_REQUEST', 'Invalid signature.');
  }
  const status = await processBillingEvent(deps, ev);
  if (status === 200) res.json({ received: true });
  else reply(500, 'INTERNAL', 'Processing failed; the event will be retried.');
};
