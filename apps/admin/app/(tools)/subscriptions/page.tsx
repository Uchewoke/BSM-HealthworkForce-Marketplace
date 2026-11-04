'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CheckField, ConfirmButton, DataTable, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, TextField, formatDate, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { money } from '@/lib/billing';

interface Metrics {
  mrrMinor: number; arrMinor: number; activePayingOrganizations: number; activeSubscriptions: number; trialOrganizations: number; pastDueSubscriptions: number;
  averageRevenuePerOrganizationMinor: number | null; trialConversionRate: number | null; churnRate: number | null; failedPaymentRate: number | null;
  grossSubscriptionRevenueMinor: number; planDistribution: { code: string; name: string; subscriptions: number; mrrMinor: number }[];
  byCustomerType: { customerType: string; mrrMinor: number; payingOrganizations: number; grossSubscriptionRevenueMinor: number }[];
  definitions: Record<string, string>; window: { from: string; to: string };
}
interface Plan {
  id: string; code: string; name: string; customerType: string; billingInterval: string; priceAmount: number; isActive: boolean; isPublic: boolean; stripePriceId: string | null; trialDays: number;
  entitlements: Record<string, unknown>;
}
interface Sub { organization_id: string; organization_name: string; customer_type: string; billing_mode: string; plan_name: string; status: string; billing_interval: string; unit_amount_minor: string; current_period_end: string | null; cancel_at_period_end: boolean }

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { active: 'success', trialing: 'info', past_due: 'warning', unpaid: 'danger', canceled: 'neutral', incomplete: 'neutral', paused: 'neutral' };

function MetricsCard() {
  const m = useApi<Metrics>('/admin/billing/metrics');
  return (
    <Card title="Revenue and subscriptions (last 30 days)">
      <QueryBoundary state={m}>
        {(d) => (
          <>
            <DataTable caption="Subscription metrics" rows={[
              ['Monthly recurring revenue (MRR)', money(d.mrrMinor)], ['Annual recurring revenue (ARR)', money(d.arrMinor)],
              ['Active paying organizations', String(d.activePayingOrganizations)], ['Active subscriptions', String(d.activeSubscriptions)],
              ['Trial organizations', String(d.trialOrganizations)], ['Past-due subscriptions', String(d.pastDueSubscriptions)],
              ['Average revenue per organization', d.averageRevenuePerOrganizationMinor === null ? '—' : money(d.averageRevenuePerOrganizationMinor)],
              ['Trial-to-paid conversion', pct(d.trialConversionRate)], ['Churn rate', pct(d.churnRate)], ['Failed payment rate', pct(d.failedPaymentRate)],
              ['Gross subscription revenue (billings collected, not profit)', money(d.grossSubscriptionRevenueMinor)], ['Refunds and credits', 'Not tracked yet'],
            ]} rowKey={(r) => r[0]!} columns={[{ header: 'Metric', cell: (r) => r[0] }, { header: 'Value', cell: (r) => r[1] }]} />
            <DataTable caption="By customer category" rows={d.byCustomerType} rowKey={(r) => r.customerType} columns={[
              { header: 'Category', cell: (r) => titleCase(r.customerType) }, { header: 'MRR', cell: (r) => money(r.mrrMinor) },
              { header: 'Paying organizations', cell: (r) => r.payingOrganizations }, { header: 'Gross revenue in window', cell: (r) => money(r.grossSubscriptionRevenueMinor) },
            ]} />
            <DataTable caption="Plan distribution" rows={d.planDistribution} rowKey={(r) => r.code} columns={[
              { header: 'Plan', cell: (r) => r.name }, { header: 'Subscriptions', cell: (r) => r.subscriptions }, { header: 'MRR', cell: (r) => money(r.mrrMinor) },
            ]} />
            <details><summary>How these are defined</summary><ul>{Object.entries(d.definitions).map(([k, v]) => <li key={k}><strong>{titleCase(k)}:</strong> {v}</li>)}</ul></details>
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

function PlanEditor({ plan, onSaved }: { plan: Plan; onSaved: () => void }) {
  const client = useClient();
  const [price, setPrice] = useState(plan.stripePriceId ?? '');
  const [active, setActive] = useState(plan.isActive);
  const [isPublic, setPublic] = useState(plan.isPublic);
  const save = useAction(async () => { await client.patch(`/admin/billing/plans/${plan.id}`, { isActive: active, isPublic, ...(price !== (plan.stripePriceId ?? '') ? { stripePriceId: price || null } : {}) }); onSaved(); });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Stripe price id" name="stripePriceId" value={price} onChange={setPrice} hint="price_… from the Stripe dashboard. Cannot change once customers are on the plan." />
        <CheckField label="Active (can be purchased)" checked={active} onChange={setActive} />
        <CheckField label="Public (shown to customers)" checked={isPublic} onChange={setPublic} />
      </div>
      <Button type="submit" pending={save.pending}>Save {plan.name} ({plan.billingInterval})</Button>
    </form>
  );
}

function Plans() {
  const plans = useApi<{ plans: Plan[] }>('/admin/billing/plans');
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Card title="Plan catalogue">
      <p className="muted">Prices are stored in the database in cents. A plan can be purchased only when it is active, public and has a Stripe price attached. Price and interval cannot change after customers subscribe: create a new plan instead.</p>
      <QueryBoundary state={plans}>
        {(d) => (
          <>
            <DataTable caption="Plans" rows={d.plans} rowKey={(p) => p.id} columns={[
              { header: 'Plan', cell: (p) => `${p.name} (${p.customerType}, ${p.billingInterval})` }, { header: 'Price', cell: (p) => money(p.priceAmount) },
              { header: 'Status', cell: (p) => <>{p.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>} {!p.isPublic && <Badge tone="info">Private</Badge>} {!p.stripePriceId && <Badge tone="warning">No Stripe price</Badge>}</> },
              { header: '', cell: (p) => <Button tone="secondary" onClick={() => setEditing(editing === p.id ? null : p.id)}>{editing === p.id ? 'Close' : 'Edit'}</Button> },
            ]} />
            {d.plans.filter((p) => p.id === editing).map((p) => <PlanEditor key={p.id} plan={p} onSaved={() => { setEditing(null); void plans.reload(); }} />)}
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

function SubscriptionList() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const list = useApi<{ subscriptions: Sub[]; total: number; pageSize: number }>('/admin/billing/subscriptions', { page, status: status || undefined });
  return (
    <Card title="Subscriptions">
      <SelectField label="Status" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All"
        options={['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused'].map((s) => ({ value: s, label: titleCase(s) }))} />
      <QueryBoundary state={list}>
        {(d) => (
          <>
            <DataTable caption="Subscriptions" rows={d.subscriptions} rowKey={(s) => s.organization_id} empty="No subscriptions yet." columns={[
              { header: 'Organization', cell: (s) => `${s.organization_name} (${s.customer_type})` }, { header: 'Plan', cell: (s) => s.plan_name },
              { header: 'Status', cell: (s) => <Badge tone={TONE[s.status]}>{titleCase(s.status)}</Badge> }, { header: 'Price', cell: (s) => `${money(s.unit_amount_minor)} / ${s.billing_interval}` },
              { header: 'Period ends', cell: (s) => <>{formatDate(s.current_period_end)}{s.cancel_at_period_end && ' (cancelling)'}</> }, { header: 'Gating', cell: (s) => titleCase(s.billing_mode) },
            ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

interface OrgDetail {
  organization: { id: string; name: string; type: string; billing_mode: string };
  subscription: null | { plan_code: string; status: string; current_period_end: string | null; grace_period_end: string | null };
  events: { event_type: string; processing_status: string; attempt_count: number; last_error_code: string | null; received_at: string }[];
  adjustments: { id: string; discount_type: string; discount_value: number; duration: string; reason_code: string; consumed_at: string | null; revoked_at: string | null }[];
}

function OrganizationControls() {
  const client = useClient();
  const [q, setQ] = useState('');
  const [orgId, setOrgId] = useState('');
  const found = useApi<{ organizations: { id: string; name: string; type: string }[] }>(q.trim().length >= 2 ? '/admin/billing/organizations' : null, { q: q.trim() });
  const detail = useApi<OrgDetail>(orgId ? `/admin/billing/organizations/${orgId}` : null);
  const setMode = useAction(async (mode: 'exempt' | 'enforced') => { await client.put(`/admin/billing/organizations/${orgId}/mode`, { mode }); await detail.reload(); });
  const resync = useAction(async () => { await client.post(`/admin/billing/organizations/${orgId}/resync`); await detail.reload(); });
  const [adj, setAdj] = useState({ discountType: 'percent', discountValue: '10', duration: 'once', durationMonths: '3', reasonCode: 'founding_customer' });
  const discount = useAction(async () => {
    await client.post('/admin/billing/adjustments', {
      organizationId: orgId, discountType: adj.discountType, discountValue: adj.discountType === 'amount' ? Math.round(Number(adj.discountValue) * 100) : Number(adj.discountValue),
      duration: adj.duration, ...(adj.duration === 'repeating' ? { durationMonths: Number(adj.durationMonths) } : {}), reasonCode: adj.reasonCode,
    });
    await detail.reload();
  });
  const revoke = useAction(async (id: string) => { await client.post(`/admin/billing/adjustments/${id}/revoke`); await detail.reload(); });
  return (
    <Card title="Organization billing controls">
      <TextField label="Find organization" name="orgSearch" value={q} onChange={(v) => { setQ(v); setOrgId(''); }} hint="At least 2 letters of the name." />
      {(found.data?.organizations.length ?? 0) > 0 && <SelectField label="Organization" name="orgId" value={orgId} onChange={setOrgId} placeholder="Choose" options={found.data!.organizations.map((o) => ({ value: o.id, label: `${o.name} (${o.type})` }))} />}
      {orgId && (
        <QueryBoundary state={detail}>
          {(d) => (
            <>
              <ErrorAlert error={setMode.error ?? resync.error ?? discount.error ?? revoke.error} />
              <p>Gating: <Badge tone={d.organization.billing_mode === 'enforced' ? 'warning' : 'neutral'}>{titleCase(d.organization.billing_mode)}</Badge>{' '}
                {d.organization.billing_mode === 'enforced'
                  ? <ConfirmButton tone="secondary" label="Stop gating" message="This organization will get every feature again, whatever its subscription." pending={setMode.pending} onConfirm={() => setMode.run('exempt')} />
                  : <ConfirmButton tone="secondary" label="Start gating" message="Paid features for this organization will depend on its subscription from now on. Without an active plan they stop working." pending={setMode.pending} onConfirm={() => setMode.run('enforced')} />}
              </p>
              {d.subscription ? <p>Plan {d.subscription.plan_code}: <Badge tone={TONE[d.subscription.status]}>{titleCase(d.subscription.status)}</Badge>, period ends {formatDate(d.subscription.current_period_end)}.{' '}
                <Button tone="secondary" pending={resync.pending} onClick={() => void resync.run()}>Re-sync from Stripe</Button></p> : <p className="muted">No subscription.</p>}
              <DataTable caption="Recent billing events" rows={d.events} rowKey={(e) => `${e.event_type}${e.received_at}`} empty="No billing events." columns={[
                { header: 'Event', cell: (e) => e.event_type }, { header: 'Outcome', cell: (e) => <Badge tone={e.processing_status === 'failed' ? 'danger' : 'neutral'}>{titleCase(e.processing_status)}</Badge> },
                { header: 'Attempts', cell: (e) => e.attempt_count }, { header: 'Error', cell: (e) => e.last_error_code ?? '—' }, { header: 'Received', cell: (e) => formatDateTime(e.received_at) },
              ]} />
              <h3>Approved discounts</h3>
              <DataTable caption="Discounts" rows={d.adjustments} rowKey={(a) => a.id} empty="No discounts." columns={[
                { header: 'Discount', cell: (a) => (a.discount_type === 'percent' ? `${a.discount_value}%` : money(a.discount_value)) }, { header: 'Duration', cell: (a) => titleCase(a.duration) },
                { header: 'Reason', cell: (a) => titleCase(a.reason_code) }, { header: 'State', cell: (a) => (a.revoked_at ? 'Revoked' : a.consumed_at ? 'Used' : 'Available') },
                { header: '', cell: (a) => (!a.revoked_at && !a.consumed_at ? <Button tone="secondary" onClick={() => void revoke.run(a.id)}>Revoke</Button> : null) },
              ]} />
              <form onSubmit={(e) => { e.preventDefault(); void discount.run(); }} noValidate>
                <Alert tone="info">A discount is applied once, at this organization&apos;s next checkout. Percentages above 50% need a super admin. Every discount is recorded in the audit log.</Alert>
                <div className="form-grid">
                  <SelectField label="Type" name="discountType" value={adj.discountType} onChange={(v) => setAdj({ ...adj, discountType: v })} options={[{ value: 'percent', label: 'Percent off' }, { value: 'amount', label: 'Dollars off' }]} />
                  <TextField label={adj.discountType === 'percent' ? 'Percent' : 'Dollars'} name="discountValue" type="number" min={1} value={adj.discountValue} onChange={(v) => setAdj({ ...adj, discountValue: v })} />
                  <SelectField label="Applies for" name="duration" value={adj.duration} onChange={(v) => setAdj({ ...adj, duration: v })} options={[{ value: 'once', label: 'First payment only' }, { value: 'repeating', label: 'A number of months' }, { value: 'forever', label: 'Every payment' }]} />
                  {adj.duration === 'repeating' && <TextField label="Months" name="durationMonths" type="number" min={1} max={36} value={adj.durationMonths} onChange={(v) => setAdj({ ...adj, durationMonths: v })} />}
                  <SelectField label="Reason" name="reasonCode" value={adj.reasonCode} onChange={(v) => setAdj({ ...adj, reasonCode: v })} options={['founding_customer', 'promotion', 'contract', 'service_recovery'].map((r) => ({ value: r, label: titleCase(r) }))} />
                </div>
                <Button type="submit" pending={discount.pending}>Approve discount</Button>
              </form>
            </>
          )}
        </QueryBoundary>
      )}
    </Card>
  );
}

export default function SubscriptionsPage() {
  return (
    <>
      <PageHeader title="Subscriptions" subtitle="Plans, customers, revenue metrics and the per-organization rollout switch." />
      <MetricsCard />
      <SubscriptionList />
      <Plans />
      <OrganizationControls />
    </>
  );
}
