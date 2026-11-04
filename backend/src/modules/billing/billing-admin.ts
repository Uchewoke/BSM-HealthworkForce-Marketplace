import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { buildSet } from '../../shared/sql.js';
import { audit } from '../audit/service.js';
import { subscriptionMetrics } from './metrics.js';
import { assertCommercialTermsEditable, createPlanBody, listPlans, replaceEntitlements, updatePlanBody } from './plans.js';
import { applyProviderSubscription, LOCAL_STATUSES } from './subscriptions.js';

const idParams = z.object({ planId: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });
const adjustmentParams = z.object({ id: z.uuid() });
const paging = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
const subsQuery = z.object({ status: z.enum(LOCAL_STATUSES).optional(), customerType: z.enum(['facility', 'agency']).optional(), ...paging });
const metricsQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const modeBody = z.object({ mode: z.enum(['exempt', 'enforced']) });
const linkBody = z.object({ providerCustomerId: z.string().regex(/^cus_[A-Za-z0-9]+$/) });
const adjustmentBody = z.object({
  organizationId: z.uuid(), planId: z.uuid().nullable().default(null),
  discountType: z.enum(['percent', 'amount']), discountValue: z.number().int().min(1).max(10_000_000),
  duration: z.enum(['once', 'repeating', 'forever']), durationMonths: z.number().int().min(1).max(36).optional(),
  validUntil: z.iso.datetime().optional(), reasonCode: z.enum(['founding_customer', 'promotion', 'contract', 'service_recovery']),
}).refine((b) => b.discountType !== 'percent' || b.discountValue <= 100, { message: 'A percentage discount cannot exceed 100.', path: ['discountValue'] })
  .refine((b) => (b.duration === 'repeating') === (b.durationMonths !== undefined), { message: 'Set a number of months for, and only for, a repeating discount.', path: ['durationMonths'] });

/** A percentage above this needs a super admin: bigger discounts are a commercial decision, not a routine one. */
const ROUTINE_PERCENT_CAP = 50;

const PLAN_COLUMNS = {
  tier: 'tier', name: 'name', description: 'description', billingInterval: 'billing_interval', priceAmount: 'price_amount', stripeProductId: 'stripe_product_id',
  stripePriceId: 'stripe_price_id', trialDays: 'trial_days', sortOrder: 'sort_order', isActive: 'is_active', isPublic: 'is_public',
};

/**
 * Staff subscription administration, mounted at /admin/billing next to the manual-invoice tools. Every route needs admin.billing_manage and
 * a verified MFA session; every change is audited with organization and plan identifiers only.
 */
export function adminSubscriptionRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const staff = requirePlatformPermission('admin.billing_manage');

  r.get('/plans', staff, async (_req, res) => { res.json({ plans: await listPlans(db, { admin: true }) }); });

  r.post('/plans', staff, validate({ body: createPlanBody }), async (req, res) => {
    const b = req.body as z.infer<typeof createPlanBody>;
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO subscription_plans (code, tier, name, customer_type, description, billing_interval, price_amount, stripe_product_id, stripe_price_id, trial_days, sort_order, is_active, is_public)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [b.code, b.tier, b.name, b.customerType, b.description, b.billingInterval, b.priceAmount, b.stripeProductId ?? null, b.stripePriceId ?? null, b.trialDays, b.sortOrder, b.isActive, b.isPublic]);
      await replaceEntitlements(tx, row!.id, b.entitlements);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'billing.plan_created', targetType: 'subscription_plan', targetId: row!.id, requestId: req.requestId, metadata: { code: b.code, priceAmount: b.priceAmount } });
      return row!.id;
    });
    res.status(201).json({ plan: (await listPlans(db, { admin: true })).find((p) => p.id === id) });
  });

  r.patch('/plans/:planId', staff, validate({ params: idParams, body: updatePlanBody }), async (req, res) => {
    const id = param(req, 'planId');
    const b = req.body as z.infer<typeof updatePlanBody>;
    await db.transaction(async (tx) => {
      const [exists] = await tx.query('SELECT id FROM subscription_plans WHERE id = $1 FOR UPDATE', [id]);
      if (!exists) throw new AppError('NOT_FOUND', 'Resource not found.');
      if (b.priceAmount !== undefined || b.billingInterval !== undefined || b.stripePriceId !== undefined) await assertCommercialTermsEditable(tx, id);
      const { entitlements, ...rest } = b;
      const set = buildSet(PLAN_COLUMNS, rest, 2);
      if (set) await tx.query(`UPDATE subscription_plans SET ${set.sql}, updated_at = now() WHERE id = $1`, [id, ...set.values]);
      if (entitlements) await replaceEntitlements(tx, id, entitlements);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'billing.plan_updated', targetType: 'subscription_plan', targetId: id, requestId: req.requestId, metadata: { fields: Object.keys(b) } });
    });
    res.json({ plan: (await listPlans(db, { admin: true })).find((p) => p.id === id) });
  });

  r.get('/subscriptions', staff, async (req, res) => {
    const q = subsQuery.parse(req.query);
    const args: unknown[] = []; let where = 'TRUE';
    if (q.status) { args.push(q.status); where += ` AND s.status = $${args.length}`; }
    if (q.customerType) { args.push(q.customerType); where += ` AND o.type = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM organization_subscriptions s JOIN organizations o ON o.id = s.organization_id WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT s.organization_id, o.name AS organization_name, o.type AS customer_type, o.billing_mode, p.code AS plan_code, p.name AS plan_name, s.status, s.billing_interval,
              s.unit_amount_minor, s.current_period_end, s.trial_end, s.cancel_at_period_end, s.grace_period_end, s.updated_at
         FROM organization_subscriptions s JOIN organizations o ON o.id = s.organization_id JOIN subscription_plans p ON p.id = s.plan_id
        WHERE ${where} ORDER BY s.updated_at DESC, s.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ subscriptions: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/metrics', staff, async (req, res) => {
    const q = metricsQuery.parse(req.query);
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date((deps.now ?? Date.now)());
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new AppError('VALIDATION_FAILED', 'The start must be before the end.');
    res.json(await subscriptionMetrics(db, from, to));
  });

  /** One organization for staff: billing mode, subscription, recent webhook outcomes (identifiers only) and adjustments. */
  r.get('/organizations/:orgId', staff, validate({ params: orgParams }), async (req, res) => {
    const id = param(req, 'orgId');
    const [org] = await db.query('SELECT id, name, type, billing_mode FROM organizations WHERE id = $1', [id]);
    if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [sub] = await db.query(
      `SELECT p.code AS plan_code, s.status, s.billing_interval, s.unit_amount_minor, s.current_period_start, s.current_period_end, s.trial_end,
              s.cancel_at_period_end, s.canceled_at, s.grace_period_end, s.updated_at
         FROM organization_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.organization_id = $1`, [id]);
    const events = await db.query(
      `SELECT event_type, processing_status, attempt_count, last_error_code, received_at FROM billing_events WHERE organization_id = $1 ORDER BY received_at DESC LIMIT 20`, [id]);
    const adjustments = await db.query(
      `SELECT id, plan_id, discount_type, discount_value, duration, duration_months, reason_code, valid_from, valid_until, consumed_at, revoked_at, created_at
         FROM billing_adjustments WHERE organization_id = $1 ORDER BY created_at DESC`, [id]);
    res.json({ organization: org, subscription: sub ?? null, events, adjustments });
  });

  /** The rollout switch: 'enforced' makes this organization's paid features depend on its subscription. */
  r.put('/organizations/:orgId/mode', staff, validate({ params: orgParams, body: modeBody }), async (req, res) => {
    const id = param(req, 'orgId');
    const rows = await db.query<{ billing_mode: string }>('UPDATE organizations SET billing_mode = $2, updated_at = now() WHERE id = $1 RETURNING billing_mode', [id, req.body.mode]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'billing.mode_changed', targetType: 'organization', targetId: id, organizationId: id, requestId: req.requestId, metadata: { mode: req.body.mode } });
    res.json({ billingMode: rows[0].billing_mode });
  });

  /** For custom contracts set up directly with the payment provider: attach the existing provider customer to the organization. */
  r.put('/organizations/:orgId/customer', staff, validate({ params: orgParams, body: linkBody }), async (req, res) => {
    const id = param(req, 'orgId');
    const [org] = await db.query('SELECT id FROM organizations WHERE id = $1', [id]);
    if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [taken] = await db.query<{ organization_id: string }>(`SELECT organization_id FROM billing_customers WHERE provider = 'stripe' AND provider_customer_id = $1`, [req.body.providerCustomerId]);
    if (taken && taken.organization_id !== id) throw new AppError('CONFLICT', 'That customer is already linked to another organization.');
    const [mine] = await db.query('SELECT 1 FROM billing_customers WHERE organization_id = $1', [id]);
    if (mine) throw new AppError('CONFLICT', 'This organization already has a billing customer.');
    await db.query(`INSERT INTO billing_customers (organization_id, provider_customer_id) VALUES ($1,$2)`, [id, req.body.providerCustomerId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'billing.customer_linked', targetType: 'organization', targetId: id, organizationId: id, requestId: req.requestId });
    res.status(201).json({ linked: true });
  });

  /** Recovery for a failed or missed webhook: re-read the subscription from the payment provider and apply it. */
  r.post('/organizations/:orgId/resync', staff, validate({ params: orgParams }), async (req, res) => {
    const id = param(req, 'orgId');
    if (!deps.billing?.configured) throw new AppError('UNAVAILABLE', 'Subscription billing is not switched on for this environment.');
    const [sub] = await db.query<{ stripe_subscription_id: string }>('SELECT stripe_subscription_id FROM organization_subscriptions WHERE organization_id = $1', [id]);
    if (!sub) throw new AppError('NOT_FOUND', 'Resource not found.');
    const fresh = await deps.billing.retrieveSubscription(sub.stripe_subscription_id);
    const result = await db.transaction(async (tx) => {
      const out = await applyProviderSubscription(tx, fresh, { kind: 'authoritative' }, deps.config.billingGraceDays);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'billing.subscription_resynced', targetType: 'organization', targetId: id, organizationId: id, requestId: req.requestId, metadata: { status: out.status ?? null } });
      return out;
    });
    res.json({ outcome: result.outcome, status: result.status ?? null });
  });

  r.get('/adjustments', staff, async (req, res) => {
    const q = z.object({ organizationId: z.uuid().optional() }).parse(req.query);
    res.json({ adjustments: await db.query(
      `SELECT id, organization_id, plan_id, discount_type, discount_value, duration, duration_months, reason_code, valid_from, valid_until, consumed_at, revoked_at, created_at
         FROM billing_adjustments WHERE ($1::uuid IS NULL OR organization_id = $1::uuid) ORDER BY created_at DESC LIMIT 100`, [q.organizationId ?? null]) });
  });

  /** An approved discount, delivered as a single-use coupon the organization's next checkout applies. */
  r.post('/adjustments', staff, validate({ body: adjustmentBody }), async (req, res) => {
    const b = req.body as z.infer<typeof adjustmentBody>;
    if (b.discountType === 'percent' && b.discountValue > ROUTINE_PERCENT_CAP && req.auth!.platformRole !== 'platform_super_admin') {
      throw new AppError('FORBIDDEN', `Discounts above ${ROUTINE_PERCENT_CAP}% need a super admin.`);
    }
    if (!deps.billing?.configured) throw new AppError('UNAVAILABLE', 'Subscription billing is not switched on for this environment.');
    const [org] = await db.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1', [b.organizationId]);
    if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (b.planId) {
      const [plan] = await db.query('SELECT 1 FROM subscription_plans WHERE id = $1 AND customer_type = $2', [b.planId, org.type]);
      if (!plan) throw new AppError('VALIDATION_FAILED', 'That plan is not for this type of organization.');
    }
    const coupon = await deps.billing.createCoupon({ type: b.discountType, value: b.discountValue, duration: b.duration, months: b.durationMonths, name: `BSM ${b.reasonCode}` }, `adjustment:${req.requestId}`);
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO billing_adjustments (organization_id, plan_id, discount_type, discount_value, duration, duration_months, stripe_coupon_id, valid_until, reason_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.organizationId, b.planId, b.discountType, b.discountValue, b.duration, b.durationMonths ?? null, coupon.id, b.validUntil ?? null, b.reasonCode, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'billing.adjustment_created', targetType: 'billing_adjustment', targetId: row!.id, organizationId: b.organizationId, requestId: req.requestId,
      metadata: { discountType: b.discountType, discountValue: b.discountValue, duration: b.duration, reasonCode: b.reasonCode } });
    res.status(201).json({ adjustment: { id: row!.id } });
  });

  r.post('/adjustments/:id/revoke', staff, validate({ params: adjustmentParams }), async (req, res) => {
    const rows = await db.query<{ organization_id: string }>(
      'UPDATE billing_adjustments SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND consumed_at IS NULL RETURNING organization_id', [param(req, 'id')]);
    if (!rows[0]) throw new AppError('CONFLICT', 'That adjustment does not exist or has already been used or revoked.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'billing.adjustment_revoked', targetType: 'billing_adjustment', targetId: param(req, 'id'), organizationId: rows[0].organization_id, requestId: req.requestId });
    res.json({ revoked: true });
  });

  return r;
}

/** Public plan catalogue at /billing/plans: active, public plans only, and no provider identifiers. */
export function publicBillingRoutes(deps: AppDeps) {
  const r = Router();
  r.get('/plans', async (req, res) => {
    const q = z.object({ customerType: z.enum(['facility', 'agency']).optional() }).parse(req.query);
    res.json({ plans: await listPlans(deps.db, { customerType: q.customerType, publicOnly: true, activeOnly: true }) });
  });
  return r;
}
