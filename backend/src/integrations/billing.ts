import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../shared/errors.js';

/** A subscription as the payment provider reports it, reduced to the fields this system uses. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  /** The provider's own status string; mapped to a local status in modules/billing/subscriptions.ts. */
  status: string;
  priceId: string | null;
  interval: 'month' | 'year' | null;
  unitAmount: number | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialStart: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** The coupon applied to the subscription, if any (used to mark an approved adjustment as consumed). */
  couponId: string | null;
  /** From the metadata this system set at checkout. Never trusted on its own: it is cross-checked against the customer mapping. */
  organizationId: string | null;
}

export interface ProviderInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountPaid: number;
  amountDue: number;
  currency: string;
  created: Date;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

export interface ProviderEvent { id: string; type: string; created: Date; object: Record<string, any> }

export interface CheckoutInput {
  customerId: string; priceId: string; organizationId: string; trialDays: number; couponId?: string | null;
  successUrl: string; cancelUrl: string;
}

/**
 * The payment provider boundary (Stripe Billing). Card details never reach this system: checkout and the billing portal are provider-hosted.
 * An unconfigured provider throws UNAVAILABLE; nothing is simulated.
 */
export interface BillingProvider {
  readonly configured: boolean;
  createCustomer(input: { organizationId: string; name: string; email: string }, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, idempotencyKey: string): Promise<ProviderSubscription>;
  retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription>;
  listInvoices(customerId: string, limit: number): Promise<ProviderInvoice[]>;
  createCoupon(input: { type: 'percent' | 'amount'; value: number; duration: 'once' | 'repeating' | 'forever'; months?: number; name: string }, idempotencyKey: string): Promise<{ id: string }>;
  /** Authenticates the raw request body against the signature header. Throws WebhookSignatureError when it does not verify. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowMs: number): ProviderEvent;
}

export class WebhookSignatureError extends Error {}

const notConfigured = () => new AppError('UNAVAILABLE', 'Subscription billing is not switched on for this environment.');

export class NotConfiguredBillingProvider implements BillingProvider {
  readonly configured = false;
  async createCustomer(): Promise<never> { throw notConfigured(); }
  async createCheckoutSession(): Promise<never> { throw notConfigured(); }
  async createPortalSession(): Promise<never> { throw notConfigured(); }
  async setCancelAtPeriodEnd(): Promise<never> { throw notConfigured(); }
  async retrieveSubscription(): Promise<never> { throw notConfigured(); }
  async listInvoices(): Promise<never> { throw notConfigured(); }
  async createCoupon(): Promise<never> { throw notConfigured(); }
  verifyWebhook(): never { throw new WebhookSignatureError('Webhook secret is not configured.'); }
}

const date = (v: unknown) => (typeof v === 'number' ? new Date(v * 1000) : null);

/** Reads a Stripe subscription object. Newer API versions carry the billing period on the item, older ones on the subscription. */
export function normalizeSubscription(raw: Record<string, any>): ProviderSubscription {
  const item = raw.items?.data?.[0];
  const price = item?.price;
  const interval = price?.recurring?.interval;
  const orgId = raw.metadata?.organization_id;
  return {
    id: String(raw.id),
    customerId: typeof raw.customer === 'string' ? raw.customer : String(raw.customer?.id ?? ''),
    status: String(raw.status),
    priceId: typeof price?.id === 'string' ? price.id : null,
    interval: interval === 'month' || interval === 'year' ? interval : null,
    unitAmount: typeof price?.unit_amount === 'number' ? price.unit_amount : null,
    currentPeriodStart: date(raw.current_period_start ?? item?.current_period_start),
    currentPeriodEnd: date(raw.current_period_end ?? item?.current_period_end),
    trialStart: date(raw.trial_start),
    trialEnd: date(raw.trial_end),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    canceledAt: date(raw.canceled_at),
    couponId: typeof raw.discount?.coupon?.id === 'string' ? raw.discount.coupon.id : typeof raw.discounts?.[0]?.coupon?.id === 'string' ? raw.discounts[0].coupon.id : null,
    organizationId: typeof orgId === 'string' ? orgId : null,
  };
}

/** Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256; the header may carry several v1 signatures during secret rotation. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, nowMs: number, toleranceSeconds = 300): void {
  if (!header) throw new WebhookSignatureError('Missing signature.');
  let t = ''; const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || sigs.length === 0) throw new WebhookSignatureError('Malformed signature.');
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) throw new WebhookSignatureError('Signature timestamp outside tolerance.');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new WebhookSignatureError('Signature mismatch.');
}

/** Flattens nested objects/arrays into Stripe's bracketed form encoding: { a: { b: 1 }, c: [x] } -> a[b]=1&c[0]=x. */
export function formEncode(input: Record<string, unknown>): string {
  const out: string[] = [];
  const add = (key: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(input)) add(k, v);
  return out.join('&');
}

/**
 * Stripe over its REST API with `fetch` (no SDK dependency). The secret key stays on the server. Request bodies and responses are never logged.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly configured = true;
  constructor(private readonly secretKey: string, private readonly webhookSecret: string, private readonly fetchImpl: typeof fetch = fetch) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BillingProvider {
    const key = env.STRIPE_SECRET_KEY; const hook = env.STRIPE_WEBHOOK_SECRET;
    return key && hook ? new StripeBillingProvider(key, hook) : new NotConfiguredBillingProvider();
  }

  private async call<T = Record<string, any>>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const qs = method === 'GET' && body ? `?${formEncode(body)}` : '';
    const res = await this.fetchImpl(`https://api.stripe.com/v1${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: method === 'POST' && body ? formEncode(body) : undefined,
    });
    if (!res.ok) {
      // Only the status is surfaced: Stripe error bodies can echo request fields.
      throw new AppError(res.status >= 500 || res.status === 429 ? 'UNAVAILABLE' : 'BAD_REQUEST', 'The payment provider rejected the request.', { providerStatus: res.status });
    }
    return (await res.json()) as T;
  }

  async createCustomer(i: { organizationId: string; name: string; email: string }, key: string) {
    const c = await this.call('POST', '/customers', { name: i.name, email: i.email, metadata: { organization_id: i.organizationId } }, key);
    return { id: String(c.id) };
  }

  async createCheckoutSession(i: CheckoutInput, key: string) {
    const s = await this.call('POST', '/checkout/sessions', {
      mode: 'subscription', customer: i.customerId, client_reference_id: i.organizationId,
      line_items: [{ price: i.priceId, quantity: 1 }],
      metadata: { organization_id: i.organizationId },
      subscription_data: { metadata: { organization_id: i.organizationId }, ...(i.trialDays > 0 ? { trial_period_days: i.trialDays } : {}) },
      ...(i.couponId ? { discounts: [{ coupon: i.couponId }] } : {}),
      success_url: i.successUrl, cancel_url: i.cancelUrl,
    }, key);
    if (typeof s.url !== 'string') throw new AppError('UNAVAILABLE', 'The payment provider did not return a checkout address.');
    return { id: String(s.id), url: s.url };
  }

  async createPortalSession(i: { customerId: string; returnUrl: string }) {
    const s = await this.call('POST', '/billing_portal/sessions', { customer: i.customerId, return_url: i.returnUrl });
    return { url: String(s.url) };
  }

  async setCancelAtPeriodEnd(id: string, cancel: boolean, key: string) {
    return normalizeSubscription(await this.call('POST', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: cancel }, key));
  }

  async retrieveSubscription(id: string) {
    return normalizeSubscription(await this.call('GET', `/subscriptions/${encodeURIComponent(id)}`));
  }

  async listInvoices(customerId: string, limit: number) {
    const r = await this.call<{ data: Record<string, any>[] }>('GET', '/invoices', { customer: customerId, limit });
    return r.data.map((x) => ({
      id: String(x.id), number: x.number ?? null, status: x.status ?? null, amountPaid: Number(x.amount_paid ?? 0), amountDue: Number(x.amount_due ?? 0),
      currency: String(x.currency ?? 'usd').toUpperCase(), created: new Date(Number(x.created) * 1000), hostedUrl: x.hosted_invoice_url ?? null, pdfUrl: x.invoice_pdf ?? null,
    }));
  }

  async createCoupon(i: { type: 'percent' | 'amount'; value: number; duration: 'once' | 'repeating' | 'forever'; months?: number; name: string }, key: string) {
    const c = await this.call('POST', '/coupons', {
      ...(i.type === 'percent' ? { percent_off: i.value } : { amount_off: i.value, currency: 'usd' }),
      duration: i.duration, max_redemptions: 1, ...(i.duration === 'repeating' ? { duration_in_months: i.months } : {}), name: i.name,
    }, key);
    return { id: String(c.id) };
  }

  verifyWebhook(rawBody: Buffer, header: string | undefined, nowMs: number): ProviderEvent {
    verifyStripeSignature(rawBody, header, this.webhookSecret, nowMs);
    let parsed: any;
    try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookSignatureError('Body is not JSON.'); }
    if (typeof parsed?.id !== 'string' || typeof parsed?.type !== 'string' || typeof parsed?.created !== 'number') throw new WebhookSignatureError('Not an event.');
    return { id: parsed.id, type: parsed.type, created: new Date(parsed.created * 1000), object: parsed.data?.object ?? {} };
  }
}
