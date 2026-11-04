import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { StripeBillingProvider, formEncode, normalizeSubscription, verifyStripeSignature, WebhookSignatureError } from '../src/integrations/billing.js';
import { decideAccess, RENEWAL_SLACK_MS } from '../src/modules/billing/entitlements.js';
import { mapProviderStatus } from '../src/modules/billing/subscriptions.js';
import { makeTestApp } from './helpers.js';

const SECRET = 'whsec_test_secret';
const KEY = 'sk_test_do_not_leak';

/** A tiny stand-in for Stripe's REST API, so the real adapter (form encoding, idempotency keys, signature check) is what the tests exercise. */
class FakeStripe {
  calls: { method: string; path: string; body: URLSearchParams; key: string | null }[] = [];
  customers = 0; coupons = 0;
  subs = new Map<string, Record<string, any>>();
  invoices: Record<string, any>[] = [];
  private idem = new Map<string, unknown>();
  fetch: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : u.search);
    const key = (init?.headers as Record<string, string>)?.['Idempotency-Key'] ?? null;
    this.calls.push({ method, path, body, key });
    if ((init?.headers as Record<string, string>).Authorization !== `Bearer ${KEY}`) return new Response('{}', { status: 401 });
    const reply = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (key && this.idem.has(key)) return reply(this.idem.get(key));
    const make = (o: unknown) => { if (key) this.idem.set(key, o); return reply(o); };
    if (method === 'POST' && path === '/customers') return make({ id: `cus_${++this.customers}` });
    if (method === 'POST' && path === '/checkout/sessions') { const id = `cs_${this.calls.length}`; return make({ id, url: `https://checkout.stripe.test/${id}` }); }
    if (method === 'POST' && path === '/billing_portal/sessions') return reply({ url: 'https://billing.stripe.test/portal' });
    if (method === 'POST' && path === '/coupons') return make({ id: `coupon_${++this.coupons}` });
    const sub = path.match(/^\/subscriptions\/(.+)$/);
    if (sub) {
      const s = this.subs.get(decodeURIComponent(sub[1]!));
      if (!s) return new Response('{}', { status: 404 });
      if (method === 'POST') s.cancel_at_period_end = body.get('cancel_at_period_end') === 'true';
      return reply(s);
    }
    if (method === 'GET' && path === '/invoices') return reply({ data: this.invoices });
    return new Response('{}', { status: 404 });
  };
}

const stripe = new FakeStripe();
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let ownerA: S, recruiterA: S, financeA: S, ownerB: S, ownerC: S, finAdmin: S, superAdmin: S, platformAdmin: S, noMfaFin: S;
let orgA: string, orgB: string, orgC: string;
let starter: any, pro: any, agencyBasic: any;
const orgUrl = (o = orgA) => `/api/v1/organizations/${o}`;
const sec = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;

const rawSub = (o: { id: string; customer: string; status: string; price: string; org?: string; end?: number; cancel?: boolean; amount?: number; interval?: 'month' | 'year'; trialEnd?: number; coupon?: string }) => ({
  id: o.id, customer: o.customer, status: o.status, cancel_at_period_end: !!o.cancel, metadata: o.org ? { organization_id: o.org } : {},
  current_period_start: sec(Date.now() - 5 * DAY), current_period_end: sec(o.end ?? Date.now() + 25 * DAY), trial_end: o.trialEnd ? sec(o.trialEnd) : null,
  ...(o.coupon ? { discount: { coupon: { id: o.coupon } } } : {}),
  items: { data: [{ price: { id: o.price, unit_amount: o.amount ?? 29900, recurring: { interval: o.interval ?? 'month' } } }] },
});
let evSeq = 0;
const evt = (type: string, object: Record<string, any>, createdMs = Date.now(), id = `evt_${++evSeq}`) => ({ id, type, created: sec(createdMs), data: { object } });
const sign = (body: string, secret = SECRET, t = sec(Date.now())) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const hook = (ev: object, signature?: string) => {
  const body = JSON.stringify(ev);
  return api().post('/api/v1/billing/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', signature ?? sign(body)).send(body);
};
const eventRow = async (id: string) => (await ctx.db.query<any>(`SELECT * FROM billing_events WHERE provider_event_id = $1`, [id]))[0];
const subRow = async (org = orgA) => (await ctx.db.query<any>('SELECT * FROM organization_subscriptions WHERE organization_id = $1', [org]))[0];
const notifs = async (s: S) => (await api().get('/api/v1/notifications').set('Cookie', s.cookie)).body.notifications as any[];
const admin = (s: S = finAdmin) => ({
  get: (u: string) => api().get(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie),
  post: (u: string, b: object = {}) => api().post(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie).send(b),
  put: (u: string, b: object = {}) => api().put(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie).send(b),
  patch: (u: string, b: object = {}) => api().patch(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie).send(b),
});
const setMode = (org: string, mode: 'exempt' | 'enforced') => admin().put(`/organizations/${org}/mode`, { mode });
const search = (s: S = ownerA, org = orgA, q = '') => api().get(`${orgUrl(org)}/talent${q}`).set('Cookie', s.cookie);
const logLines: string[] = [];

beforeAll(async () => {
  const sink = new Writable({ write(chunk, _e, cb) { logLines.push(String(chunk)); cb(); } });
  ctx = await makeTestApp({ billing: new StripeBillingProvider(KEY, SECRET, stripe.fetch), billingEnabled: true, logger: pino({ level: 'debug' }, sink) });
  ownerA = await ctx.userWithSession('owner.a@example.com');
  recruiterA = await ctx.userWithSession('recruiter.a@example.com');
  financeA = await ctx.userWithSession('finance.a@example.com');
  ownerB = await ctx.userWithSession('owner.b@example.com');
  ownerC = await ctx.userWithSession('owner.c@example.com');
  finAdmin = await ctx.adminSession('finadmin@bsm.example', 'finance_admin');
  superAdmin = await ctx.adminSession('super@bsm.example', 'platform_super_admin');
  platformAdmin = await ctx.adminSession('padmin@bsm.example', 'platform_admin');
  noMfaFin = await ctx.userWithSession('nomfa@bsm.example', 'finance_admin');

  orgA = (await api().post('/api/v1/organizations').set('Cookie', ownerA.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  orgC = (await api().post('/api/v1/organizations').set('Cookie', ownerC.cookie).send({ name: 'Care Staffing', type: 'agency' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'finance')`, [orgA, recruiterA.id, financeA.id]);
  const f = await api().post(`${orgUrl()}/facilities`).set('Cookie', ownerA.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
  await api().post(`${orgUrl()}/facilities/${f.body.facility.id}/locations`).set('Cookie', ownerA.cookie)
    .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' });
});

describe('provider adapter', () => {
  it('encodes nested form fields the way Stripe expects', () => {
    expect(formEncode({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], metadata: { a: 'b c' } }))
      .toBe('mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Ba%5D=b%20c');
  });

  it('verifies webhook signatures: valid, tampered, wrong secret, stale and malformed', () => {
    const body = Buffer.from('{"id":"evt_x"}');
    const now = Date.now();
    const good = sign(body.toString());
    expect(() => verifyStripeSignature(body, good, SECRET, now)).not.toThrow();
    expect(() => verifyStripeSignature(Buffer.from('{"id":"evt_y"}'), good, SECRET, now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(body, sign(body.toString(), 'whsec_other'), SECRET, now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(body, sign(body.toString(), SECRET, sec(now) - 3600), SECRET, now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(body, 'garbage', SECRET, now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(body, undefined, SECRET, now)).toThrow(WebhookSignatureError);
  });

  it('reads subscription periods from the subscription or from its item', () => {
    const base = rawSub({ id: 'sub_n', customer: 'cus_n', status: 'active', price: 'price_x' }) as Record<string, any>;
    expect(normalizeSubscription(base).currentPeriodEnd).toBeInstanceOf(Date);
    const { current_period_start, current_period_end, ...rest } = base;
    const moved = { ...rest, items: { data: [{ ...rest.items.data[0], current_period_start, current_period_end }] } };
    expect(normalizeSubscription(moved).currentPeriodEnd?.getTime()).toBe(current_period_end * 1000);
  });

  it('maps provider statuses explicitly', () => {
    expect(mapProviderStatus('incomplete_expired')).toBe('canceled');
    expect(mapProviderStatus('past_due')).toBe('past_due');
    expect(mapProviderStatus('something_new')).toBe('incomplete');
  });
});

describe('access rules', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const base = { current_period_end: new Date('2026-06-30T00:00:00Z'), trial_end: null, cancel_at_period_end: false, grace_period_end: null };
  it('active and trialing carry paid features', () => {
    expect(decideAccess({ ...base, status: 'active' }, now)).toMatchObject({ allowed: true, state: 'active' });
    expect(decideAccess({ ...base, status: 'trialing', trial_end: new Date('2026-06-20T00:00:00Z') }, now)).toMatchObject({ allowed: true, state: 'trial' });
  });
  it('a lapsed period is expired once the renewal tolerance has passed', () => {
    const end = new Date('2026-06-10T00:00:00Z');
    expect(decideAccess({ ...base, status: 'active', current_period_end: end }, new Date(end.getTime() + RENEWAL_SLACK_MS - 1000)).allowed).toBe(true);
    expect(decideAccess({ ...base, status: 'active', current_period_end: end }, new Date(end.getTime() + RENEWAL_SLACK_MS + 1000))).toMatchObject({ allowed: false, reason: 'expired' });
    expect(decideAccess({ ...base, status: 'trialing', trial_end: end }, new Date(end.getTime() + RENEWAL_SLACK_MS + 1000))).toMatchObject({ allowed: false, reason: 'expired' });
  });
  it('past due keeps access only inside the grace period', () => {
    expect(decideAccess({ ...base, status: 'past_due', grace_period_end: new Date('2026-06-20T00:00:00Z') }, now)).toMatchObject({ allowed: true, state: 'grace' });
    expect(decideAccess({ ...base, status: 'past_due', grace_period_end: new Date('2026-06-10T00:00:00Z') }, now)).toMatchObject({ allowed: false, reason: 'past_due_grace_ended' });
    expect(decideAccess({ ...base, status: 'past_due' }, now).allowed).toBe(false);
  });
  it('cancelling at period end keeps access to the end date and not a day past it', () => {
    const end = new Date('2026-06-30T00:00:00Z');
    expect(decideAccess({ ...base, status: 'active', cancel_at_period_end: true }, new Date(end.getTime() - 1000)).allowed).toBe(true);
    expect(decideAccess({ ...base, status: 'active', cancel_at_period_end: true }, new Date(end.getTime() + 1000)).allowed).toBe(false);
  });
  it('unpaid, canceled, paused, incomplete and no subscription carry nothing', () => {
    for (const status of ['unpaid', 'canceled', 'paused', 'incomplete']) expect(decideAccess({ ...base, status }, now).allowed).toBe(false);
    expect(decideAccess(null, now)).toMatchObject({ allowed: false, reason: 'no_subscription' });
  });
});

describe('plan catalogue', () => {
  it('lists only active public plans, separated by customer type, with integer minor-unit prices and entitlements', async () => {
    const all = await api().get('/api/v1/billing/plans');
    expect(all.status).toBe(200);
    const codes = all.body.plans.map((p: any) => p.code);
    expect(codes).toContain('facility_starter_month');
    expect(codes).not.toContain('facility_starter_year'); // inactive
    const fac = (await api().get('/api/v1/billing/plans?customerType=facility')).body.plans;
    expect(fac.every((p: any) => p.customerType === 'facility')).toBe(true);
    const agencyPlans = (await api().get('/api/v1/billing/plans?customerType=agency')).body.plans;
    expect(agencyPlans.map((p: any) => p.code).sort()).toEqual(['agency_basic_month', 'agency_growth_month']);
    starter = fac.find((p: any) => p.code === 'facility_starter_month');
    expect(starter.priceAmount).toBe(29900);
    expect(starter.entitlements).toMatchObject({ 'talent_search.monthly_limit': 50, 'active_locations.limit': 1, 'matching.enabled': true });
    expect(fac.find((p: any) => p.code === 'facility_enterprise_month').entitlements['talent_search.monthly_limit']).toBeNull(); // unlimited
    expect(JSON.stringify(all.body)).not.toMatch(/stripe|price_/i); // no provider identifiers on the public catalogue
    pro = fac.find((p: any) => p.code === 'facility_professional_month');
    agencyBasic = agencyPlans.find((p: any) => p.code === 'agency_basic_month');
  });

  it('is managed by staff with admin.billing_manage and MFA only, and every change is audited', async () => {
    expect((await admin(platformAdmin).get('/plans')).status).toBe(403);
    const noMfa = await admin(noMfaFin).get('/plans');
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.details.mfaRequired).toBe(true);
    expect((await api().get('/api/v1/admin/billing/plans')).status).toBe(401);

    const list = await admin().get('/plans');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(KEY);

    for (const [p, price] of [[starter, 'price_starter'], [pro, 'price_pro'], [agencyBasic, 'price_agency']] as const) {
      expect((await admin().patch(`/plans/${p.id}`, { stripePriceId: price })).status).toBe(200);
    }
    const created = await admin().post('/plans', {
      code: 'facility_founding_month', tier: 'founding', name: 'Founding', customerType: 'facility', billingInterval: 'month', priceAmount: 19900,
      stripePriceId: 'price_founding', isActive: true, isPublic: false, entitlements: { 'matching.enabled': true, 'active_locations.limit': 3 },
    });
    expect(created.status).toBe(201);
    expect(created.body.plan.entitlements['active_locations.limit']).toBe(3);
    const audited = await ctx.db.query<any>(`SELECT metadata FROM audit_logs WHERE action IN ('billing.plan_created','billing.plan_updated')`);
    expect(audited.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audited)).not.toMatch(/@/); // no emails in audit metadata
  });

  it('rejects unknown or mistyped entitlements and duplicate codes', async () => {
    const body = { code: 'bad_plan', tier: 'bad', name: 'Bad', customerType: 'facility', billingInterval: 'month', priceAmount: 100 };
    expect((await admin().post('/plans', { ...body, entitlements: { 'made_up.feature': true } })).status).toBe(422);
    expect((await admin().post('/plans', { ...body, entitlements: { 'matching.enabled': 5 } })).status).toBe(422);
    expect((await admin().post('/plans', { ...body, priceAmount: 9.99 })).status).toBe(422); // minor units are integers
    expect((await admin().post('/plans', { ...body, code: 'facility_founding_month' })).status).toBe(409);
  });
});

describe('checkout', () => {
  it('is refused until billing is switched on', async () => {
    const off = await makeTestApp({ billing: new StripeBillingProvider(KEY, SECRET, stripe.fetch) });
    const o = await off.userWithSession('off.owner@example.com');
    const org = (await request(off.app).post('/api/v1/organizations').set('Cookie', o.cookie).send({ name: 'Off Org', type: 'facility' })).body.organization.id;
    await off.db.query(`UPDATE organizations SET status = 'approved'`);
    const plans = (await request(off.app).get('/api/v1/billing/plans')).body.plans;
    const res = await request(off.app).post(`/api/v1/organizations/${org}/billing/checkout`).set('Cookie', o.cookie).send({ planId: plans[0].id });
    expect(res.status).toBe(503);
  });

  it('only organization owners may start checkout; other members and other organizations are turned away', async () => {
    const body = { planId: starter.id };
    const url = `${orgUrl()}/billing/checkout`;
    expect((await api().post(url).send(body)).status).toBe(401);
    expect((await api().post(url).set('Cookie', recruiterA.cookie).send(body)).status).toBe(403);
    expect((await api().post(url).set('Cookie', financeA.cookie).send(body)).status).toBe(403); // can read billing, cannot change it
    expect((await api().post(url).set('Cookie', ownerB.cookie).send(body)).status).toBe(404); // not a member: existence is not revealed
  });

  it('rejects invalid plans: unknown, wrong customer type, private, or without a provider price', async () => {
    const url = `${orgUrl()}/billing/checkout`;
    const post = (b: object) => api().post(url).set('Cookie', ownerA.cookie).send(b);
    expect((await post({ planId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await post({ planId: agencyBasic.id })).status).toBe(404); // an agency plan for a facility
    expect((await post({ planId: 'nope' })).status).toBe(422);
    const growth = (await api().get('/api/v1/billing/plans?customerType=facility')).body.plans.find((p: any) => p.code === 'facility_enterprise_month');
    expect((await post({ planId: growth.id })).status).toBe(409); // no provider price attached yet
    const founding = (await admin().get('/plans')).body.plans.find((p: any) => p.code === 'facility_founding_month');
    expect((await post({ planId: founding.id })).status).toBe(404); // private plans are not self-service
  });

  it('creates a provider checkout for the right organization using catalogue data only, and repeating it reuses the session', async () => {
    const url = `${orgUrl()}/billing/checkout`;
    const first = await api().post(url).set('Cookie', ownerA.cookie).send({ planId: starter.id, priceId: 'price_attacker', amount: 1 });
    expect(first.status).toBe(201);
    expect(first.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const second = await api().post(url).set('Cookie', ownerA.cookie).send({ planId: starter.id });
    expect(second.body.url).toBe(first.body.url);
    expect(stripe.customers).toBe(1); // one provider customer, not two
    const session = stripe.calls.filter((c) => c.path === '/checkout/sessions')[0]!.body;
    expect(session.get('line_items[0][price]')).toBe('price_starter');
    expect(session.get('client_reference_id')).toBe(orgA);
    expect(session.get('metadata[organization_id]')).toBe(orgA);
    expect(session.get('subscription_data[metadata][organization_id]')).toBe(orgA);
    expect(session.get('success_url')).toContain(`/facility/${orgA}/subscription/success`);
    const [cust] = await ctx.db.query<any>('SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1', [orgA]);
    expect(cust.provider_customer_id).toBe('cus_1');
    expect(await subRow()).toBeUndefined(); // a redirect or a started checkout is not a subscription
  });
});

describe('webhooks', () => {
  it('rejects missing, wrong and stale signatures without recording anything', async () => {
    const ev = evt('customer.subscription.created', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'active', price: 'price_starter', org: orgA }));
    const body = JSON.stringify(ev);
    expect((await api().post('/api/v1/billing/webhooks/stripe').set('Content-Type', 'application/json').send(body)).status).toBe(400);
    expect((await hook(ev, sign(body, 'whsec_wrong'))).status).toBe(400);
    expect((await hook(ev, sign(body, SECRET, sec(Date.now()) - 3600))).status).toBe(400);
    expect(await eventRow(ev.id)).toBeUndefined();
    expect(await subRow()).toBeUndefined();
  });

  it('an active subscription event creates the local projection and tells the billing contacts', async () => {
    const ev = evt('customer.subscription.created', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'active', price: 'price_starter', org: orgA }), Date.now() - 60_000);
    expect((await hook(ev)).status).toBe(200);
    expect(await subRow()).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_1' });
    expect(Number((await subRow()).unit_amount_minor)).toBe(29900);
    expect((await eventRow(ev.id)).processing_status).toBe('processed');
    expect((await notifs(ownerA)).some((n) => n.type === 'subscription.active')).toBe(true);
    expect((await notifs(financeA)).some((n) => n.type === 'subscription.active')).toBe(true);
    expect((await notifs(recruiterA)).some((n) => n.type === 'subscription.active')).toBe(false); // no billing.read
    const overview = await api().get(`${orgUrl()}/billing/subscription`).set('Cookie', ownerA.cookie);
    expect(overview.body.subscription).toMatchObject({ status: 'active', plan_code: 'facility_starter_month' });
    expect(JSON.stringify(overview.body)).not.toMatch(/sub_1|cus_1/); // provider ids are not sent to the browser
  });

  it('a duplicate delivery is acknowledged and not applied twice', async () => {
    const ev = evt('invoice.paid', { customer: 'cus_1', amount_paid: 29900, currency: 'usd' });
    expect((await hook(ev)).status).toBe(200);
    expect((await hook(ev)).status).toBe(200);
    expect((await ctx.db.query<any>(`SELECT * FROM billing_events WHERE provider_event_id = $1`, [ev.id])).length).toBe(1);
    const row = await eventRow(ev.id);
    expect(row).toMatchObject({ processing_status: 'processed', attempt_count: 1 });
    expect(Number(row.amount_minor)).toBe(29900);
    expect(row.organization_id).toBe(orgA);
  });

  it('an older event arriving late cannot roll the state back', async () => {
    const t = Date.now();
    await hook(evt('customer.subscription.updated', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'past_due', price: 'price_starter', org: orgA }), t - 10_000));
    expect((await subRow()).status).toBe('past_due');
    const stale = evt('customer.subscription.updated', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'active', price: 'price_starter', org: orgA }), t - 50_000);
    expect((await hook(stale)).status).toBe(200);
    expect((await subRow()).status).toBe('past_due');
    expect((await eventRow(stale.id)).processing_status).toBe('ignored');
  });

  it('past due starts one grace period that replays do not extend, and a recovery clears it', async () => {
    const first = (await subRow()).grace_period_end as Date;
    expect(first.getTime()).toBeGreaterThan(Date.now() + 5 * DAY);
    await hook(evt('customer.subscription.updated', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'past_due', price: 'price_starter', org: orgA }), Date.now() + 1000));
    expect(+(await subRow()).grace_period_end).toBe(+first);
    expect((await notifs(ownerA)).filter((n) => n.type === 'subscription.past_due').length).toBe(1);
    await hook(evt('customer.subscription.updated', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'active', price: 'price_starter', org: orgA }), Date.now() + 2000));
    expect(await subRow()).toMatchObject({ status: 'active', grace_period_end: null });
  });

  it('a failed payment is recorded, audited and notified without payment details', async () => {
    const ev = evt('invoice.payment_failed', { customer: 'cus_1', amount_due: 29900, currency: 'usd', last_finalization_error: { message: 'CANARY-CARD-4242' } });
    expect((await hook(ev)).status).toBe(200);
    expect((await notifs(ownerA)).some((n) => n.type === 'payment.failed')).toBe(true);
    const [a] = await ctx.db.query<any>(`SELECT metadata FROM audit_logs WHERE action = 'billing.payment_failed'`);
    expect(a.metadata).toMatchObject({ eventId: ev.id, amountMinor: 29900 });
    expect(logLines.join('')).not.toContain('CANARY-CARD-4242'); // payloads are never logged
    expect(JSON.stringify(await ctx.db.query('SELECT * FROM billing_events'))).not.toContain('CANARY-CARD-4242');
  });

  it('a failed processing run is retried on redelivery and then succeeds (unknown price attached later)', async () => {
    await ctx.db.query(`INSERT INTO billing_customers (organization_id, provider_customer_id) VALUES ($1, 'cus_b')`, [orgB]);
    const ev = evt('customer.subscription.created', rawSub({ id: 'sub_b', customer: 'cus_b', status: 'active', price: 'price_late', org: orgB }));
    const first = await hook(ev);
    expect(first.status).toBe(500);
    expect(await eventRow(ev.id)).toMatchObject({ processing_status: 'failed', last_error_code: 'unknown_price' });
    const enterprise = (await admin().get('/plans')).body.plans.find((p: any) => p.code === 'facility_enterprise_month');
    expect((await admin().patch(`/plans/${enterprise.id}`, { stripePriceId: 'price_late' })).status).toBe(200); // staff attach the missing price
    expect((await hook(ev)).status).toBe(200);
    expect(await eventRow(ev.id)).toMatchObject({ processing_status: 'processed', attempt_count: 2, last_error_code: null });
    expect(await subRow(orgB)).toMatchObject({ status: 'active' });
  });

  it('metadata naming a different organization than the customer belongs to is refused and changes nothing', async () => {
    const ev = evt('customer.subscription.updated', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'canceled', price: 'price_starter', org: orgB }), Date.now() + 5000);
    expect((await hook(ev)).status).toBe(200); // permanent: not retried
    expect(await eventRow(ev.id)).toMatchObject({ processing_status: 'failed', last_error_code: 'organization_mismatch' });
    expect((await subRow()).status).toBe('active');
  });

  it('events for customers that are not ours are ignored', async () => {
    const ev = evt('customer.subscription.created', rawSub({ id: 'sub_zz', customer: 'cus_stranger', status: 'active', price: 'price_starter' }));
    expect((await hook(ev)).status).toBe(200);
    expect((await eventRow(ev.id)).processing_status).toBe('ignored');
  });

  it('a second live subscription for the same organization is flagged, not silently swapped in', async () => {
    const ev = evt('customer.subscription.created', rawSub({ id: 'sub_dup', customer: 'cus_1', status: 'active', price: 'price_pro', org: orgA }), Date.now() + 9000);
    expect((await hook(ev)).status).toBe(500);
    expect((await eventRow(ev.id)).last_error_code).toBe('duplicate_subscription');
    expect((await subRow()).stripe_subscription_id).toBe('sub_1');
  });

  it('a completed checkout session is resolved by reading the subscription from the provider, never from the redirect', async () => {
    await ctx.db.query(`INSERT INTO billing_customers (organization_id, provider_customer_id) VALUES ($1, 'cus_c')`, [orgC]);
    stripe.subs.set('sub_c', rawSub({ id: 'sub_c', customer: 'cus_c', status: 'trialing', price: 'price_agency', org: orgC, amount: 49900, trialEnd: Date.now() + 14 * DAY }));
    const ev = evt('checkout.session.completed', { mode: 'subscription', customer: 'cus_c', subscription: 'sub_c', client_reference_id: orgC });
    expect((await hook(ev)).status).toBe(200);
    expect(await subRow(orgC)).toMatchObject({ status: 'trialing' });
    const lie = evt('checkout.session.completed', { mode: 'subscription', customer: 'cus_c', subscription: 'sub_c', client_reference_id: orgA });
    expect((await hook(lie)).status).toBe(200);
    expect((await eventRow(lie.id)).last_error_code).toBe('organization_mismatch');
    expect((await subRow(orgC)).organization_id).toBe(orgC);
  });

  it('unrelated event types are acknowledged and ignored', async () => {
    const ev = evt('charge.dispute.created', { customer: 'cus_1' });
    expect((await hook(ev)).status).toBe(200);
    expect((await eventRow(ev.id)).processing_status).toBe('ignored');
  });
});

describe('tenant isolation', () => {
  it('only members with the right permission can see an organization\'s billing', async () => {
    const get = (s: S, path: string, org = orgA) => api().get(`${orgUrl(org)}/billing${path}`).set('Cookie', s.cookie);
    for (const path of ['', '/subscription', '/subscription-invoices']) {
      expect((await get(ownerA, path)).status).toBe(200);
      expect((await get(financeA, path)).status).toBe(200);
      expect((await get(recruiterA, path)).status).toBe(403);
      expect((await get(ownerB, path)).status).toBe(404); // a different organization's owner
    }
    for (const path of ['/entitlements', '/usage']) {
      expect((await get(recruiterA, path)).status).toBe(200); // any member may see what their plan allows
      expect((await get(ownerB, path)).status).toBe(404);
    }
    expect((await api().post(`${orgUrl()}/billing/portal`).set('Cookie', ownerB.cookie)).status).toBe(404);
    expect((await api().post(`${orgUrl()}/billing/cancel`).set('Cookie', ownerB.cookie)).status).toBe(404);
  });

  it('invoice history is read from the provider for the caller\'s own customer only', async () => {
    stripe.invoices = [{ id: 'in_1', number: 'ABC-001', status: 'paid', amount_paid: 29900, amount_due: 0, currency: 'usd', created: sec(Date.now()), hosted_invoice_url: 'https://invoice.stripe.test/1', invoice_pdf: null, customer_email: 'x@y.z' }];
    const res = await api().get(`${orgUrl()}/billing/subscription-invoices`).set('Cookie', ownerA.cookie);
    expect(res.body.invoices[0]).toMatchObject({ number: 'ABC-001', amountPaid: 29900, currency: 'USD' });
    expect(JSON.stringify(res.body)).not.toContain('x@y.z');
    const listCall = stripe.calls.filter((c) => c.path === '/invoices').at(-1)!;
    expect(listCall.body.get('customer')).toBe('cus_1');
    const none = await api().get(`${orgUrl(orgB)}/billing/subscription-invoices`).set('Cookie', ownerB.cookie);
    expect(none.status).toBe(200);
    expect(stripe.calls.filter((c) => c.path === '/invoices').at(-1)!.body.get('customer')).toBe('cus_b');
  });
});

describe('cancel and resume', () => {
  it('owners cancel at the end of the period; access stays until then; resuming reverses it; nobody else may', async () => {
    stripe.subs.set('sub_1', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'active', price: 'price_starter', org: orgA }));
    const url = (a: string) => `${orgUrl()}/billing/${a}`;
    expect((await api().post(url('cancel')).set('Cookie', recruiterA.cookie)).status).toBe(403);
    expect((await api().post(url('cancel')).set('Cookie', financeA.cookie)).status).toBe(403);
    expect((await api().post(url('resume')).set('Cookie', ownerA.cookie)).status).toBe(409); // nothing to resume
    const res = await api().post(url('cancel')).set('Cookie', ownerA.cookie);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect(stripe.calls.filter((c) => c.path === '/subscriptions/sub_1' && c.method === 'POST').at(-1)!.body.get('cancel_at_period_end')).toBe('true');
    expect((await api().post(url('cancel')).set('Cookie', ownerA.cookie)).status).toBe(409);
    expect((await api().post(url('resume')).set('Cookie', ownerA.cookie)).status).toBe(200);
    expect((await subRow()).cancel_at_period_end).toBe(false);
    const actions = (await ctx.db.query<any>(`SELECT action FROM audit_logs WHERE organization_id = $1`, [orgA])).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['billing.subscription_cancel_requested', 'billing.subscription_resumed', 'billing.checkout_started']));
  });

  it('the portal needs a billing account and returns a provider-hosted address', async () => {
    const ok = await api().post(`${orgUrl()}/billing/portal`).set('Cookie', ownerA.cookie);
    expect(ok.body.url).toBe('https://billing.stripe.test/portal');
    expect((await api().post(`${orgUrl(orgC)}/billing/portal`).set('Cookie', ownerC.cookie)).status).toBe(200);
    const bare = await ctx.userWithSession('bare@example.com');
    const bareOrg = (await api().post('/api/v1/organizations').set('Cookie', bare.cookie).send({ name: 'Bare Org', type: 'facility' })).body.organization.id;
    expect((await api().post(`${orgUrl(bareOrg)}/billing/portal`).set('Cookie', bare.cookie)).status).toBe(409);
  });

  it('an existing subscription blocks a second checkout', async () => {
    const res = await api().post(`${orgUrl()}/billing/checkout`).set('Cookie', ownerA.cookie).send({ planId: pro.id });
    expect(res.status).toBe(409);
  });
});

describe('entitlement enforcement', () => {
  it('organizations outside billing behave exactly as before, even with the master switch on', async () => {
    expect((await search(ownerB, orgB)).status).toBe(200);
    expect((await api().get(`${orgUrl(orgB)}/billing/entitlements`).set('Cookie', ownerB.cookie)).body.enforced).toBe(false);
  });

  it('switching an organization to enforced is a staff action, audited, and nobody else can do it', async () => {
    expect((await api().put(`/api/v1/admin/billing/organizations/${orgA}/mode`).set('Cookie', ownerA.cookie).send({ mode: 'enforced' })).status).toBe(403);
    expect((await admin(platformAdmin).put(`/organizations/${orgA}/mode`, { mode: 'enforced' })).status).toBe(403);
    expect((await admin().put(`/organizations/${orgA}/mode`, { mode: 'sideways' })).status).toBe(422);
    expect((await setMode(orgA, 'enforced')).status).toBe(200);
    expect((await ctx.db.query<any>(`SELECT 1 FROM audit_logs WHERE action = 'billing.mode_changed' AND organization_id = $1`, [orgA])).length).toBe(1);
  });

  it('a subscribed, enforced organization gets its plan\'s features', async () => {
    const e = await api().get(`${orgUrl()}/billing/entitlements`).set('Cookie', recruiterA.cookie);
    expect(e.body).toMatchObject({ enforced: true, plan: { code: 'facility_starter_month' }, entitlements: { 'talent_search.monthly_limit': 50 } });
    expect((await search()).status).toBe(200);
    const usage = await api().get(`${orgUrl()}/billing/usage`).set('Cookie', ownerA.cookie);
    expect(usage.body.usage.find((u: any) => u.key === 'talent_search.monthly_limit')).toMatchObject({ used: 1, limit: 50, kind: 'monthly' });
    expect(usage.body.usage.find((u: any) => u.key === 'active_locations.limit')).toMatchObject({ used: 1, limit: 1, kind: 'current' });
  });

  it('usage limits stop the request and failed requests do not consume the allowance', async () => {
    await ctx.db.query(`UPDATE plan_entitlements SET value = '3' WHERE plan_id = $1 AND entitlement_key = 'talent_search.monthly_limit'`, [starter.id]);
    await ctx.db.query(`DELETE FROM usage_records`);
    expect((await search(ownerA, orgA, '?professionId=not-a-uuid')).status).toBeGreaterThanOrEqual(400); // rejected request: reservation given back
    expect(Number((await ctx.db.query<any>('SELECT coalesce(sum(quantity),0) AS n FROM usage_records'))[0].n)).toBe(0);
    for (let i = 0; i < 3; i++) expect((await search()).status).toBe(200);
    const over = await search();
    expect(over.status).toBe(403);
    expect(over.body.error.details).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED', entitlement: 'talent_search.monthly_limit', limit: 3, upgradeRequired: true });
  });

  it('concurrent requests cannot exceed the limit', async () => {
    await ctx.db.query(`DELETE FROM usage_records`);
    const results = await Promise.all(Array.from({ length: 8 }, () => search()));
    expect(results.filter((r) => r.status === 200).length).toBe(3);
    expect(results.filter((r) => r.status === 403).length).toBe(5);
    expect(Number((await ctx.db.query<any>('SELECT quantity FROM usage_records'))[0].quantity)).toBe(3);
  });

  it('usage records hold counters only: no names, credentials or personal data', async () => {
    const cols = (await ctx.db.query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_records' ORDER BY 1`)).map((c) => c.column_name);
    expect(cols).toEqual(['created_at', 'entitlement_key', 'id', 'organization_id', 'period_end', 'period_start', 'quantity', 'updated_at']);
  });

  it('the location limit applies to new and re-activated locations, and moving to a bigger plan lifts it', async () => {
    const fac = (await api().get(`${orgUrl()}/facilities`).set('Cookie', ownerA.cookie)).body.facilities[0].id;
    const add = (name: string) => api().post(`${orgUrl()}/facilities/${fac}/locations`).set('Cookie', ownerA.cookie)
      .send({ name, addressLine1: '2 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' });
    const blocked = await add('Second');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED', entitlement: 'active_locations.limit', limit: 1 });
    // Upgrade through the provider event, as in production.
    await hook(evt('customer.subscription.updated', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'active', price: 'price_pro', org: orgA, amount: 79900 }), Date.now() + 20_000));
    expect((await subRow()).plan_id).toBe(pro.id);
    const second = await add('Second');
    expect(second.status).toBe(201);
    // Deactivate, fill the allowance back to its limit, and re-activation is blocked once it would exceed it.
    await ctx.db.query(`UPDATE plan_entitlements SET value = '2' WHERE plan_id = $1 AND entitlement_key = 'active_locations.limit'`, [pro.id]);
    await api().patch(`${orgUrl()}/facilities/${fac}/locations/${second.body.location.id}`).set('Cookie', ownerA.cookie).send({ active: false });
    expect((await add('Third')).status).toBe(201);
    const reactivate = await api().patch(`${orgUrl()}/facilities/${fac}/locations/${second.body.location.id}`).set('Cookie', ownerA.cookie).send({ active: true });
    expect(reactivate.status).toBe(403);
  });

  it('past due keeps features during the grace period and removes them after it', async () => {
    await ctx.db.query(`UPDATE plan_entitlements SET value = '1000' WHERE entitlement_key = 'talent_search.monthly_limit' AND plan_id = $1`, [pro.id]);
    await ctx.db.query(`UPDATE organization_subscriptions SET status = 'past_due', grace_period_end = now() + interval '2 days' WHERE organization_id = $1`, [orgA]);
    expect((await search()).status).toBe(200);
    await ctx.db.query(`UPDATE organization_subscriptions SET grace_period_end = now() - interval '1 minute' WHERE organization_id = $1`, [orgA]);
    const res = await search();
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', reason: 'past_due_grace_ended' });
    expect((await api().get(`${orgUrl()}/billing/subscription`).set('Cookie', ownerA.cookie)).status).toBe(200); // billing stays reachable to recover
  });

  it('cancelled, unpaid and expired subscriptions lose paid features but the organization and its data remain', async () => {
    for (const status of ['unpaid', 'canceled']) {
      await ctx.db.query(`UPDATE organization_subscriptions SET status = $2, grace_period_end = NULL WHERE organization_id = $1`, [orgA, status]);
      expect((await search()).status).toBe(403);
    }
    await ctx.db.query(`UPDATE organization_subscriptions SET status = 'active', current_period_end = now() - interval '10 days' WHERE organization_id = $1`, [orgA]);
    expect((await search()).status).toBe(403);
    expect((await api().get(`${orgUrl()}`).set('Cookie', ownerA.cookie)).status).toBe(200);
    expect((await api().get(`${orgUrl()}/jobs`).set('Cookie', ownerA.cookie)).status).toBe(200); // unpaid access never blocks existing data
    await ctx.db.query(`UPDATE organization_subscriptions SET status = 'active', current_period_end = now() + interval '20 days' WHERE organization_id = $1`, [orgA]);
    expect((await search()).status).toBe(200);
  });

  it('enforced organizations without a subscription are denied every paid feature, with the same answer for matching, analytics and agency work', async () => {
    await setMode(orgB, 'enforced');
    await ctx.db.query('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgB]);
    const denied = (r: request.Response) => { expect(r.status).toBe(403); expect(r.body.error.details).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', reason: 'no_subscription' }); };
    denied(await search(ownerB, orgB));
    denied(await api().post(`${orgUrl(orgB)}/jobs/00000000-0000-4000-8000-000000000000/match-runs`).set('Cookie', ownerB.cookie).send({}));
    denied(await api().get(`${orgUrl(orgB)}/analytics`).set('Cookie', ownerB.cookie));
    await setMode(orgC, 'enforced');
    await ctx.db.query('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgC]);
    denied(await api().get(`${orgUrl(orgC)}/agency/analytics`).set('Cookie', ownerC.cookie));
    denied(await api().post(`${orgUrl(orgC)}/agency/jobs/00000000-0000-4000-8000-000000000000/submissions`).set('Cookie', ownerC.cookie).send({ professionalId: '00000000-0000-4000-8000-000000000000' }));
    const roster = await api().post(`${orgUrl(orgC)}/agency/roster/invitations`).set('Cookie', ownerC.cookie).send({ email: 'someone@example.com' });
    expect(roster.status).toBe(403);
  });

  it('professionals are never asked to subscribe: nothing on the professional side checks a plan', async () => {
    const pro1 = await ctx.userWithSession('free.pro@example.com');
    expect((await api().get('/api/v1/professionals/me').set('Cookie', pro1.cookie)).status).not.toBe(402);
    expect((await api().get('/api/v1/jobs').set('Cookie', pro1.cookie)).status).toBe(200);
  });
});

describe('staff controls', () => {
  it('plan commercial terms are frozen once customers are on a plan; descriptive fields are not', async () => {
    const attempt = await admin().patch(`/plans/${starter.id}`, { priceAmount: 1 });
    expect(attempt.status === 409 || attempt.status === 200).toBe(true);
    const inUse = (await ctx.db.query<any>('SELECT plan_id FROM organization_subscriptions LIMIT 1'))[0].plan_id as string;
    expect((await admin().patch(`/plans/${inUse}`, { priceAmount: 1 })).status).toBe(409);
    expect((await admin().patch(`/plans/${inUse}`, { stripePriceId: 'price_other' })).status).toBe(409);
    expect((await admin().patch(`/plans/${inUse}`, { description: 'Updated copy.' })).status).toBe(200);
    expect((await admin().patch(`/plans/${inUse}`, { entitlements: { 'matching.enabled': 'yes' } })).status).toBe(422);
  });

  it('approved discounts need an audited staff action, with a cap that only a super admin can exceed', async () => {
    const body = { organizationId: orgB, discountType: 'percent', discountValue: 20, duration: 'repeating', durationMonths: 6, reasonCode: 'founding_customer' };
    expect((await api().post('/api/v1/admin/billing/adjustments').set('Cookie', ownerB.cookie).send(body)).status).toBe(403);
    expect((await admin(platformAdmin).post('/adjustments', body)).status).toBe(403);
    expect((await admin().post('/adjustments', { ...body, discountValue: 150 })).status).toBe(422);
    expect((await admin().post('/adjustments', { ...body, durationMonths: undefined })).status).toBe(422);
    expect((await admin().post('/adjustments', { ...body, discountValue: 80 })).status).toBe(403);
    expect((await admin(superAdmin).post('/adjustments', { ...body, discountValue: 80 })).status).toBe(201);
    const ok = await admin().post('/adjustments', body);
    expect(ok.status).toBe(201);
    const coupon = stripe.calls.filter((c) => c.path === '/coupons').at(-1)!.body;
    expect(coupon.get('percent_off')).toBe('20');
    expect(coupon.get('max_redemptions')).toBe('1');
    expect((await ctx.db.query<any>(`SELECT metadata FROM audit_logs WHERE action = 'billing.adjustment_created' AND organization_id = $1`, [orgB])).length).toBe(2);
    // The discount is applied at that organization's next checkout, and only theirs.
    await ctx.db.query('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgB]);
    await api().post(`${orgUrl(orgB)}/billing/checkout`).set('Cookie', ownerB.cookie).send({ planId: pro.id });
    expect(stripe.calls.filter((c) => c.path === '/checkout/sessions').at(-1)!.body.get('discounts[0][coupon]')).toMatch(/^coupon_/);
    await api().post(`${orgUrl(orgA)}/billing/checkout`).set('Cookie', ownerA.cookie).send({ planId: pro.id }); // A already subscribed: refused
    const revoke = await admin().post(`/adjustments/${ok.body.adjustment.id}/revoke`);
    expect(revoke.status).toBe(200);
    expect((await admin().post(`/adjustments/${ok.body.adjustment.id}/revoke`)).status).toBe(409);
  });

  it('a discount used by a subscription is marked as consumed', async () => {
    const [adj] = await ctx.db.query<any>(`SELECT stripe_coupon_id FROM billing_adjustments WHERE organization_id = $1 AND revoked_at IS NULL LIMIT 1`, [orgB]);
    await hook(evt('customer.subscription.created', rawSub({ id: 'sub_b2', customer: 'cus_b', status: 'active', price: 'price_pro', org: orgB, amount: 79900, coupon: adj.stripe_coupon_id }), Date.now() + 30_000));
    expect((await ctx.db.query<any>('SELECT consumed_at FROM billing_adjustments WHERE stripe_coupon_id = $1', [adj.stripe_coupon_id]))[0].consumed_at).not.toBeNull();
  });

  it('staff can link a provider customer for a custom contract, and re-sync a subscription from the provider', async () => {
    const bare = await ctx.userWithSession('custom@example.com');
    const customOrg = (await api().post('/api/v1/organizations').set('Cookie', bare.cookie).send({ name: 'Custom Co', type: 'facility' })).body.organization.id;
    expect((await admin().put(`/organizations/${customOrg}/customer`, { providerCustomerId: 'cus_1' })).status).toBe(409); // belongs to Alpha
    expect((await admin().put(`/organizations/${customOrg}/customer`, { providerCustomerId: 'not-a-customer' })).status).toBe(422);
    expect((await admin().put(`/organizations/${customOrg}/customer`, { providerCustomerId: 'cus_custom' })).status).toBe(201);

    stripe.subs.set('sub_1', rawSub({ id: 'sub_1', customer: 'cus_1', status: 'past_due', price: 'price_pro', org: orgA, amount: 79900 }));
    const res = await admin().post(`/organizations/${orgA}/resync`);
    expect(res.status).toBe(200);
    expect((await subRow()).status).toBe('past_due');
    expect((await admin().get(`/organizations/${orgA}`)).body.subscription.plan_code).toBe('facility_professional_month');
  });
});

describe('metrics', () => {
  it('reports documented definitions from the projection and the webhook ledger', async () => {
    await ctx.db.query('DELETE FROM organization_subscriptions');
    await ctx.db.query('DELETE FROM billing_events');
    const [starterRow, agencyRow] = [starter.id, agencyBasic.id];
    const ins = (org: string, plan: string, status: string, interval: string, amount: number, extra = '') => ctx.db.query(
      `INSERT INTO organization_subscriptions (organization_id, plan_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, unit_amount_minor, last_event_created ${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1,$2,'cus_m',$3,$4,$5,$6,now() ${extra ? ', ' + extra.split('=')[1] : ''})`, [org, plan, `sub_m_${org}`, status, interval, amount]);
    await ins(orgA, starterRow, 'active', 'month', 29900);
    await ins(orgC, agencyRow, 'active', 'year', 499000);
    await ins(orgB, starterRow, 'trialing', 'month', 29900);
    await ctx.db.query(`INSERT INTO billing_events (provider_event_id, event_type, processing_status, organization_id, amount_minor) VALUES
      ('m1','invoice.paid','processed',$1,29900), ('m2','invoice.paid','processed',$2,499000), ('m3','invoice.payment_failed','processed',$1,29900), ('m4','invoice.paid','failed',$1,100)`, [orgA, orgC]);
    const m = (await admin().get('/metrics')).body;
    const annualMonthly = Math.round(499000 / 12);
    expect(m.mrrMinor).toBe(29900 + annualMonthly); // the trial and nothing else is excluded
    expect(m.arrMinor).toBe((29900 + annualMonthly) * 12);
    expect(m).toMatchObject({ activePayingOrganizations: 2, activeSubscriptions: 2, trialOrganizations: 1, pastDueSubscriptions: 0 });
    expect(m.averageRevenuePerOrganizationMinor).toBe(Math.round((29900 + annualMonthly) / 2));
    expect(m.grossSubscriptionRevenueMinor).toBe(29900 + 499000); // failed-processing events do not count
    expect(m.failedPaymentRate).toBeCloseTo(1 / 3, 3);
    expect(m.refundsAndCreditsMinor).toBeNull();
    expect(m.byCustomerType.map((t: any) => t.customerType)).toEqual(['agency', 'facility']);
    expect(m.planDistribution.map((p: any) => p.code).sort()).toEqual(['agency_basic_month', 'facility_starter_month']);
    expect(m.definitions.grossSubscriptionRevenue).toMatch(/not profit/);
    expect((await admin(platformAdmin).get('/metrics')).status).toBe(403);
    expect((await admin().get('/metrics?from=2026-02-01&to=2026-01-01')).status).toBe(422);
  });
});

describe('secrets and logging', () => {
  it('the provider key never appears in any response or log line', async () => {
    const bodies = [
      (await admin().get('/plans')).text, (await admin().get('/subscriptions')).text, (await admin().get('/metrics')).text,
      (await api().get(`${orgUrl()}/billing`).set('Cookie', ownerA.cookie)).text, (await api().get('/api/v1/billing/plans')).text,
    ].join('');
    expect(bodies).not.toContain(KEY);
    expect(bodies).not.toContain(SECRET);
    expect(logLines.join('')).not.toContain(KEY);
    expect(logLines.join('')).not.toContain(SECRET);
  });

  it('staff subscription lists are paged and filterable', async () => {
    const res = await admin().get('/subscriptions?status=active&customerType=agency');
    expect(res.body.subscriptions.every((s: any) => s.status === 'active' && s.customer_type === 'agency')).toBe(true);
    expect(res.body.total).toBe(1);
  });
});
