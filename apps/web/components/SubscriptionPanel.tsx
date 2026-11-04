'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmButton, DataTable, DefinitionList, ErrorAlert, LinkButton, PageHeader, QueryBoundary, formatDate, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { money } from '@/lib/billing';
import { useOrg } from '@/lib/org';
import { LIVE_STATUSES, SUBSCRIPTION_TONE, featureLines, priceLabel, usageLabel, type Plan } from '@/lib/subscription';

interface Overview {
  billingAvailable: boolean; billingMode: 'exempt' | 'enforced'; canManage: boolean;
  subscription: null | {
    status: string; billing_interval: 'month' | 'year'; unit_amount_minor: string; current_period_end: string | null; trial_end: string | null;
    cancel_at_period_end: boolean; grace_period_end: string | null; plan_name: string;
  };
  plans: Plan[];
}
interface Usage { usage: { key: string; used: number; limit: number | null; kind: 'monthly' | 'current' }[]; periodEnd: string }
interface ProviderInvoice { id: string; number: string | null; status: string | null; amountPaid: number; amountDue: number; created: string; hostedUrl: string | null }

/**
 * Subscription overview shared by the facility and agency portals. This page only presents what the server reports:
 * the server decides what the organization can use, and the payment provider decides what has been paid.
 */
export function SubscriptionPanel({ area }: { area: 'facility' | 'agency' }) {
  const { org, can } = useOrg();
  const client = useClient();
  const base = `/${area}/${org.id}/subscription`;
  const readable = can('billing.read');
  const overview = useApi<Overview>(readable ? `/organizations/${org.id}/billing` : null);
  const usage = useApi<Usage>(readable ? `/organizations/${org.id}/billing/usage` : null);
  const invoices = useApi<{ available: boolean; invoices: ProviderInvoice[] }>(readable ? `/organizations/${org.id}/billing/subscription-invoices` : null);
  const portal = useAction(async () => { const r = await client.post<{ url: string }>(`/organizations/${org.id}/billing/portal`); window.location.assign(r.url); });
  const change = useAction(async (what: 'cancel' | 'resume') => { await client.post(`/organizations/${org.id}/billing/${what}`); await overview.reload(); });
  if (!readable) return <Alert tone="info">Your role cannot view billing. Ask an owner or a finance team member.</Alert>;

  return (
    <>
      <PageHeader title="Subscription" subtitle="Your plan, usage and payment history." actions={<LinkButton href={`${base}/plans`} tone="secondary">Compare plans</LinkButton>} />
      <QueryBoundary state={overview}>
        {(d) => {
          const s = d.subscription;
          return (
            <>
              {!d.billingAvailable && <Alert tone="info">Online subscriptions are not switched on yet. Contact BSM if you would like to subscribe.</Alert>}
              {d.billingAvailable && d.billingMode === 'exempt' && <Alert tone="info">Your organization currently has full access without a paid plan. You can still subscribe in advance.</Alert>}
              {s?.status === 'past_due' && (
                <Alert tone="warning" title="Your last payment did not go through">
                  Paid features stay available until {formatDate(s.grace_period_end)}. Update your payment method to avoid interruption.
                </Alert>
              )}
              {s?.status === 'unpaid' && <Alert tone="error" title="Subscription unpaid">Paid features are paused. Update your payment method to restore them. Your data is safe.</Alert>}
              {s?.cancel_at_period_end && <Alert tone="warning">This subscription ends on {formatDate(s.current_period_end)}. You keep access until then.</Alert>}
              <Card title="Current plan">
                {!s ? (
                  <>
                    <p>No subscription yet.</p>
                    <LinkButton href={`${base}/plans`}>Choose a plan</LinkButton>
                  </>
                ) : (
                  <>
                    <DefinitionList items={[
                      ['Plan', <>{s.plan_name} <Badge tone={SUBSCRIPTION_TONE[s.status]}>{titleCase(s.status)}</Badge></>],
                      ['Price', `${money(s.unit_amount_minor)} / ${s.billing_interval}`],
                      [s.status === 'trialing' ? 'Trial ends' : s.cancel_at_period_end ? 'Access ends' : 'Renews', formatDate(s.status === 'trialing' ? s.trial_end : s.current_period_end)],
                    ]} />
                    {d.canManage ? (
                      <div className="row" style={{ marginTop: 12 }}>
                        <ErrorAlert error={portal.error ?? change.error} />
                        <Button pending={portal.pending} onClick={() => void portal.run()}>Manage payment method or plan</Button>
                        {s.cancel_at_period_end
                          ? <Button tone="secondary" pending={change.pending} onClick={() => void change.run('resume')}>Keep my subscription</Button>
                          : ['active', 'trialing', 'past_due'].includes(s.status) && (
                            <ConfirmButton label="Cancel subscription" pending={change.pending} message={`Your plan stays active until ${formatDate(s.current_period_end)}, then paid features stop. Your data and invoices are kept.`} onConfirm={() => change.run('cancel')} />
                          )}
                        {['canceled', 'incomplete'].includes(s.status) && <LinkButton href={`${base}/plans`}>Choose a plan</LinkButton>}
                      </div>
                    ) : <p className="muted">Only an owner can change the plan or payment method.</p>}
                  </>
                )}
              </Card>
            </>
          );
        }}
      </QueryBoundary>
      <QueryBoundary state={usage}>
        {(u) => u.usage.length === 0 ? null : (
          <Card title="Usage">
            {u.usage.map((m) => (
              <div key={m.key} style={{ marginBottom: 10 }}>
                <label htmlFor={`m-${m.key}`}>{usageLabel(m.key)}: <strong>{m.used}</strong>{m.limit === null ? ' (unlimited)' : ` of ${m.limit}`}{m.kind === 'monthly' ? ` · resets ${formatDate(u.periodEnd)}` : ''}</label>
                {m.limit !== null && <progress id={`m-${m.key}`} value={Math.min(m.used, m.limit)} max={Math.max(m.limit, 1)} style={{ width: '100%' }} />}
              </div>
            ))}
          </Card>
        )}
      </QueryBoundary>
      <QueryBoundary state={invoices}>
        {(i) => !i.available || i.invoices.length === 0 ? null : (
          <Card title="Subscription payments">
            <DataTable caption="Subscription payments" rows={i.invoices} rowKey={(x) => x.id} columns={[
              { header: 'Number', cell: (x) => x.number ?? '—' }, { header: 'Date', cell: (x) => formatDate(x.created) },
              { header: 'Amount', cell: (x) => money(x.amountPaid || x.amountDue) }, { header: 'Status', cell: (x) => titleCase(x.status ?? 'unknown') },
              { header: 'Receipt', cell: (x) => (x.hostedUrl ? <a href={x.hostedUrl} target="_blank" rel="noreferrer">View</a> : '—') },
            ]} />
          </Card>
        )}
      </QueryBoundary>
      <p className="muted">Platform-fee invoices issued by BSM for completed assignments are listed under <Link href={`/${area}/${org.id}/${area === 'facility' ? 'billing' : 'placements'}`}>{area === 'facility' ? 'Billing' : 'Placements'}</Link>.</p>
    </>
  );
}

/** Plan comparison and checkout. The browser only names a plan; the server decides the price and builds the provider checkout. */
export function PlanPicker({ area }: { area: 'facility' | 'agency' }) {
  const { org } = useOrg();
  const client = useClient();
  const overview = useApi<Overview>(`/organizations/${org.id}/billing`);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const checkout = useAction(async (planId: string) => { const r = await client.post<{ url: string }>(`/organizations/${org.id}/billing/checkout`, { planId }); window.location.assign(r.url); });
  return (
    <>
      <PageHeader title="Plans" subtitle="Choose the plan that fits your organization." actions={<LinkButton href={`/${area}/${org.id}/subscription`} tone="secondary">Back to subscription</LinkButton>} />
      <ErrorAlert error={checkout.error} />
      <QueryBoundary state={overview}>
        {(d) => {
          const hasYear = d.plans.some((p) => p.billingInterval === 'year');
          const shown = d.plans.filter((p) => p.billingInterval === interval);
          const subscribed = d.subscription !== null && LIVE_STATUSES.includes(d.subscription.status);
          return (
            <>
              {!d.billingAvailable && <Alert tone="info">Online checkout is not switched on yet. Contact BSM to subscribe.</Alert>}
              {!d.canManage && <Alert tone="info">Only an organization owner can subscribe or change plans.</Alert>}
              {hasYear && (
                <div className="row" role="group" aria-label="Billing interval">
                  <Button tone={interval === 'month' ? 'primary' : 'secondary'} aria-pressed={interval === 'month'} onClick={() => setInterval('month')}>Monthly</Button>
                  <Button tone={interval === 'year' ? 'primary' : 'secondary'} aria-pressed={interval === 'year'} onClick={() => setInterval('year')}>Annual</Button>
                </div>
              )}
              <div className="grid">
                {shown.map((p) => (
                  <Card key={p.id} title={p.name}>
                    <p style={{ fontSize: '1.4rem', margin: '0 0 4px' }}><strong>{priceLabel(p)}</strong></p>
                    {p.trialDays > 0 && <p><Badge tone="info">{p.trialDays}-day trial</Badge></p>}
                    <p className="muted">{p.description}</p>
                    <ul>{featureLines(p.entitlements).map((l) => <li key={l}>{l}</li>)}</ul>
                    {d.canManage && d.billingAvailable && (
                      p.purchasable
                        ? <Button pending={checkout.pending} disabled={subscribed} onClick={() => void checkout.run(p.id)}>Subscribe</Button>
                        : <span className="muted">Not available to purchase yet</span>
                    )}
                  </Card>
                ))}
              </div>
              {subscribed && <Alert tone="info">You already have a subscription. To switch plans, use “Manage payment method or plan” on the subscription page.</Alert>}
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
