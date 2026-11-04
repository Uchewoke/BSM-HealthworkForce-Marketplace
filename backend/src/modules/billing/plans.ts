import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { ENTITLEMENT_KEYS } from './entitlements.js';

export interface PlanRow {
  id: string; code: string; tier: string; name: string; customer_type: 'facility' | 'agency'; description: string; billing_interval: 'month' | 'year';
  price_amount: string; currency: string; stripe_product_id: string | null; stripe_price_id: string | null; trial_days: number; sort_order: number;
  is_active: boolean; is_public: boolean;
}

/** Plans with their entitlements. Public callers get no Stripe identifiers, only whether the plan can be purchased yet. */
export async function listPlans(q: Queryable, opts: { customerType?: 'facility' | 'agency'; publicOnly?: boolean; activeOnly?: boolean; admin?: boolean }) {
  const args: unknown[] = [];
  const where: string[] = [];
  if (opts.customerType) { args.push(opts.customerType); where.push(`customer_type = $${args.length}`); }
  if (opts.publicOnly) where.push('is_public');
  if (opts.activeOnly) where.push('is_active');
  const plans = await q.query<PlanRow>(
    `SELECT * FROM subscription_plans ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY customer_type, sort_order, billing_interval DESC, code`, args);
  const ents = plans.length ? await q.query<{ plan_id: string; entitlement_key: string; value_type: string; value: unknown }>(
    'SELECT plan_id, entitlement_key, value_type, value FROM plan_entitlements WHERE plan_id = ANY($1::uuid[]) ORDER BY entitlement_key', [plans.map((p) => p.id)]) : [];
  return plans.map((p) => ({
    id: p.id, code: p.code, tier: p.tier, name: p.name, customerType: p.customer_type, description: p.description, billingInterval: p.billing_interval,
    priceAmount: Number(p.price_amount), currency: p.currency, trialDays: p.trial_days, sortOrder: p.sort_order, isActive: p.is_active, isPublic: p.is_public,
    purchasable: p.is_active && p.is_public && !!p.stripe_price_id,
    ...(opts.admin ? { stripeProductId: p.stripe_product_id, stripePriceId: p.stripe_price_id } : {}),
    entitlements: Object.fromEntries(ents.filter((e) => e.plan_id === p.id).map((e) => [e.entitlement_key, e.value])),
  }));
}

/** One entitlement value, checked against the type its key is defined with (null = unlimited, integers only). */
const entitlementValue = z.union([z.boolean(), z.number().int().min(0).max(1_000_000), z.string().max(40), z.null()]);
export const entitlementsBody = z.record(z.string(), entitlementValue).superRefine((v, ctx) => {
  for (const [key, val] of Object.entries(v)) {
    const type = (ENTITLEMENT_KEYS as Record<string, string>)[key];
    const ok = type === 'boolean' ? typeof val === 'boolean' : type === 'integer' ? (val === null || typeof val === 'number') : type === 'string' ? typeof val === 'string' : false;
    if (!ok) ctx.addIssue({ code: 'custom', path: [key], message: type ? `Expected a ${type} value.` : 'Unknown entitlement.' });
  }
});

export async function replaceEntitlements(q: Queryable, planId: string, values: Record<string, boolean | number | string | null>) {
  await q.query('DELETE FROM plan_entitlements WHERE plan_id = $1', [planId]);
  for (const [key, value] of Object.entries(values)) {
    await q.query('INSERT INTO plan_entitlements (plan_id, entitlement_key, value_type, value) VALUES ($1,$2,$3,$4::jsonb)',
      [planId, key, (ENTITLEMENT_KEYS as Record<string, string>)[key], JSON.stringify(value)]);
  }
}

const code = z.string().regex(/^[a-z0-9_]{3,60}$/);
const stripeId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const planFields = {
  tier: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().trim().min(2).max(80), description: z.string().trim().max(500),
  billingInterval: z.enum(['month', 'year']), priceAmount: z.number().int().min(0).max(100_000_000),
  stripeProductId: stripeId('prod').nullable(), stripePriceId: stripeId('price').nullable(),
  trialDays: z.number().int().min(0).max(365), sortOrder: z.number().int().min(0).max(1000), isActive: z.boolean(), isPublic: z.boolean(),
};
export const createPlanBody = z.object({
  code, customerType: z.enum(['facility', 'agency']),
  ...planFields,
  description: planFields.description.default(''), stripeProductId: planFields.stripeProductId.optional(), stripePriceId: planFields.stripePriceId.optional(),
  trialDays: planFields.trialDays.default(0), sortOrder: planFields.sortOrder.default(100), isActive: planFields.isActive.default(false), isPublic: planFields.isPublic.default(true),
  entitlements: entitlementsBody.default({}),
});
/** No defaults here: a PATCH must change only the fields it names (zod keeps .default() values inside .partial()). */
export const updatePlanBody = z.object(planFields).partial().extend({ entitlements: entitlementsBody.optional() });

/** Price, interval and Stripe price cannot change once customers are on a plan: create a new plan instead. */
export async function assertCommercialTermsEditable(q: Queryable, planId: string) {
  const [n] = await q.query<{ n: string }>('SELECT count(*) AS n FROM organization_subscriptions WHERE plan_id = $1', [planId]);
  if (Number(n?.n ?? 0) > 0) throw new AppError('CONFLICT', 'Customers are subscribed to this plan, so its price and Stripe price cannot change. Create a new plan instead.');
}
