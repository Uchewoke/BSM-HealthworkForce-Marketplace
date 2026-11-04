import { Router, type RequestHandler } from 'express';
import { orgRoleCan } from '@bsm/permissions';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { billingCtx, decideAccess, getOrganizationEntitlements } from './entitlements.js';
import { listPlans } from './plans.js';
import { applyProviderSubscription, LIVE_STATUSES, loadSubscriptionView, type LocalStatus } from './subscriptions.js';
import { usageSummary } from './usage.js';

const orgParams = z.object({ orgId: z.uuid() });
const checkoutBody = z.object({ planId: z.uuid() });

/** What the browser may know about entitlements: presentation data only. The server enforces independently on every request. */
export function entitlementView(e: Awaited<ReturnType<typeof getOrganizationEntitlements>>) {
  return {
    enforced: e.enforced,
    access: e.access,
    plan: e.plan,
    entitlements: Object.fromEntries(Object.entries(e.values).map(([k, v]) => [k, v.value])),
    periodStart: e.periodStart,
    periodEnd: e.periodEnd,
  };
}

/**
 * Subscription billing for an organization, mounted at /organizations/:orgId/billing next to the manual-invoice routes.
 * Reading needs billing.read (usage and entitlements: org.read); starting, changing or ending a subscription needs billing.manage (owners).
 * Subscription state is never written from these requests' bodies: it comes from the payment provider.
 */
export function subscriptionRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'billing.read');
  const manage = requireOrgPermission(deps, 'billing.manage');
  const orgRead = requireOrgPermission(deps, 'org.read');
  const area = (type: string) => (type === 'agency' ? 'agency' : 'facility');

  const loadOrg = async (id: string) => {
    const [o] = await db.query<{ id: string; name: string; type: string; billing_mode: string }>('SELECT id, name, type, billing_mode FROM organizations WHERE id = $1', [id]);
    if (!o) throw new AppError('NOT_FOUND', 'Resource not found.');
    return o;
  };
  const requireLive = () => {
    if (!deps.config.billingEnabled || !deps.billing?.configured) throw new AppError('UNAVAILABLE', 'Subscription billing is not switched on yet.');
    return deps.billing;
  };

  r.get('/', validate({ params: orgParams }), read, async (req, res) => {
    const orgId = req.membership!.organizationId;
    const org = await loadOrg(orgId);
    const e = await getOrganizationEntitlements(db, orgId, billingCtx(deps));
    res.json({
      billingAvailable: deps.config.billingEnabled && !!deps.billing?.configured,
      billingMode: org.billing_mode,
      canManage: orgRoleCan(req.membership!.role, 'billing.manage'),
      subscription: await loadSubscriptionView(db, orgId),
      access: e.access,
      plans: await listPlans(db, { customerType: org.type as 'facility' | 'agency', publicOnly: true, activeOnly: true }),
    });
  });

  r.get('/subscription', validate({ params: orgParams }), read, async (req, res) => {
    const orgId = req.membership!.organizationId;
    const sub = await loadSubscriptionView(db, orgId);
    res.json({ subscription: sub, access: sub ? decideAccess(sub as Parameters<typeof decideAccess>[0], new Date(now())) : null });
  });

  r.get('/entitlements', validate({ params: orgParams }), orgRead, async (req, res) => {
    res.json(entitlementView(await getOrganizationEntitlements(db, req.membership!.organizationId, billingCtx(deps))));
  });

  r.get('/usage', validate({ params: orgParams }), orgRead, async (req, res) => {
    const orgId = req.membership!.organizationId;
    res.json(await usageSummary(db, orgId, await getOrganizationEntitlements(db, orgId, billingCtx(deps))));
  });

  /** Subscription charges, read live from the payment provider (nothing is copied here). The manual placement-fee invoices stay at /invoices. */
  r.get('/subscription-invoices', validate({ params: orgParams }), read, async (req, res) => {
    const orgId = req.membership!.organizationId;
    const [customer] = await db.query<{ provider_customer_id: string }>('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [orgId]);
    if (!customer || !deps.billing?.configured) return void res.json({ invoices: [], available: !!deps.billing?.configured });
    const invoices = await deps.billing.listInvoices(customer.provider_customer_id, 24);
    res.json({ available: true, invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, amountPaid: i.amountPaid, amountDue: i.amountDue, currency: i.currency, created: i.created, hostedUrl: i.hostedUrl, pdfUrl: i.pdfUrl })) });
  });

  r.post('/checkout', validate({ params: orgParams, body: checkoutBody }), manage, requireApprovedOrg(deps), async (req, res) => {
    const provider = requireLive();
    const orgId = req.membership!.organizationId;
    const org = await loadOrg(orgId);
    // The plan id from the browser is only a choice among plans this organization may buy; price and Stripe ids come from our catalog.
    const [plan] = await db.query<{ id: string; code: string; stripe_price_id: string | null; trial_days: number }>(
      `SELECT id, code, stripe_price_id, trial_days FROM subscription_plans WHERE id = $1 AND is_active AND is_public AND customer_type = $2`, [req.body.planId, org.type]);
    if (!plan) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (!plan.stripe_price_id) throw new AppError('CONFLICT', 'This plan is not available to purchase yet.');
    const [existing] = await db.query<{ status: LocalStatus }>('SELECT status FROM organization_subscriptions WHERE organization_id = $1', [orgId]);
    if (existing && LIVE_STATUSES.includes(existing.status)) {
      throw new AppError('CONFLICT', 'This organization already has a subscription. Use the billing portal to change or update it.');
    }

    let [customer] = await db.query<{ provider_customer_id: string }>('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [orgId]);
    if (!customer) {
      const created = await provider.createCustomer({ organizationId: orgId, name: org.name, email: req.auth!.email }, `customer:${orgId}`);
      await db.query(`INSERT INTO billing_customers (organization_id, provider_customer_id, billing_email) VALUES ($1,$2,$3) ON CONFLICT (organization_id) DO NOTHING`, [orgId, created.id, req.auth!.email]);
      [customer] = await db.query<{ provider_customer_id: string }>('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [orgId]);
    }

    const [adj] = await db.query<{ stripe_coupon_id: string }>(
      `SELECT stripe_coupon_id FROM billing_adjustments
        WHERE organization_id = $1 AND (plan_id IS NULL OR plan_id = $2) AND revoked_at IS NULL AND consumed_at IS NULL
          AND valid_from <= $3 AND (valid_until IS NULL OR valid_until > $3) ORDER BY created_at LIMIT 1`, [orgId, plan.id, new Date(now())]);

    const base = deps.config.webUrl;
    // Repeating the request within ten minutes returns the same provider session instead of opening a second one.
    const session = await provider.createCheckoutSession({
      customerId: customer!.provider_customer_id, priceId: plan.stripe_price_id, organizationId: orgId, trialDays: plan.trial_days, couponId: adj?.stripe_coupon_id ?? null,
      successUrl: `${base}/${area(org.type)}/${orgId}/subscription/success`, cancelUrl: `${base}/${area(org.type)}/${orgId}/subscription/plans`,
    }, `checkout:${orgId}:${plan.id}:${Math.floor(now() / 600_000)}`);
    await audit(db, { actorUserId: req.auth!.userId, action: 'billing.checkout_started', targetType: 'subscription_plan', targetId: plan.id, organizationId: orgId, requestId: req.requestId, metadata: { plan: plan.code, discounted: !!adj } });
    res.status(201).json({ url: session.url });
  });

  r.post('/portal', validate({ params: orgParams }), manage, async (req, res) => {
    const provider = requireLive();
    const orgId = req.membership!.organizationId;
    const [customer] = await db.query<{ provider_customer_id: string }>('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [orgId]);
    if (!customer) throw new AppError('CONFLICT', 'There is no billing account yet. Choose a plan first.');
    const org = await loadOrg(orgId);
    const session = await provider.createPortalSession({ customerId: customer.provider_customer_id, returnUrl: `${deps.config.webUrl}/${area(org.type)}/${orgId}/subscription` });
    await audit(db, { actorUserId: req.auth!.userId, action: 'billing.portal_opened', targetType: 'organization', targetId: orgId, organizationId: orgId, requestId: req.requestId });
    res.json({ url: session.url });
  });

  /** Cancel or resume at the end of the paid period. Access continues until that date; the data and billing history are kept. */
  const setCancel = (cancel: boolean) => (async (req, res) => {
    const provider = requireLive();
    const orgId = req.membership!.organizationId;
    const [sub] = await db.query<{ id: string; stripe_subscription_id: string; status: LocalStatus; cancel_at_period_end: boolean; current_period_end: Date | null }>(
      'SELECT id, stripe_subscription_id, status, cancel_at_period_end, current_period_end FROM organization_subscriptions WHERE organization_id = $1', [orgId]);
    if (!sub) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (cancel) {
      if (!['active', 'trialing', 'past_due'].includes(sub.status)) throw new AppError('CONFLICT', 'This subscription cannot be cancelled in its current state.');
      if (sub.cancel_at_period_end) throw new AppError('CONFLICT', 'This subscription is already set to end at the close of the period.');
    } else {
      if (!sub.cancel_at_period_end || !['active', 'trialing'].includes(sub.status) || (sub.current_period_end && sub.current_period_end.getTime() < now())) {
        throw new AppError('CONFLICT', 'This subscription cannot be resumed. Choose a plan to subscribe again.');
      }
    }
    const updated = await provider.setCancelAtPeriodEnd(sub.stripe_subscription_id, cancel, `cancel:${sub.id}:${cancel}:${Math.floor(now() / 600_000)}`);
    await db.transaction(async (tx) => {
      await applyProviderSubscription(tx, updated, { kind: 'authoritative' }, deps.config.billingGraceDays);
      await audit(tx, { actorUserId: req.auth!.userId, action: cancel ? 'billing.subscription_cancel_requested' : 'billing.subscription_resumed', targetType: 'organization_subscription', targetId: sub.id, organizationId: orgId, requestId: req.requestId });
    });
    res.json({ subscription: await loadSubscriptionView(db, orgId) });
  }) as RequestHandler;
  r.post('/cancel', validate({ params: orgParams }), manage, setCancel(true));
  r.post('/resume', validate({ params: orgParams }), manage, setCancel(false));

  return r;
}
