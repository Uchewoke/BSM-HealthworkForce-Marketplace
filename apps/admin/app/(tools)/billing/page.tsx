'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, TextField, formatDate, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { INVOICE_TONE, money } from '@/lib/billing';

interface Inv { id: string; organization_name: string; number: string | null; status: string; period_start: string; period_end: string; total_cents: string; due_date: string | null }
interface Unbilled { awaitingTimesheet: { assignment_id: string; title: string; starts_at: string; timesheet_status: string | null }[]; feeBps: number | null; items: { assignment_id: string; title: string; starts_at: string; minutes: number; rate_cents: number; gross: number; amount: number | null }[] }

function Fee() {
  const client = useClient();
  const fee = useApi<{ bps: number | null; configured: boolean }>('/admin/billing/fee');
  const [pct, setPct] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => { await client.put('/admin/billing/fee', { bps: Math.round(Number(pct) * 100) }); setSaved(true); await fee.reload(); });
  return (
    <Card title="Platform fee">
      <p className="muted">BSM invoices the organization that owns a job a percentage of the agreed pay on each <strong>completed</strong> assignment. The rate is a business decision with no default: invoices cannot be generated until you set it. Changing it affects only invoices created afterwards.</p>
      <QueryBoundary state={fee}>
        {(d) => (
          <form onSubmit={(e) => { e.preventDefault(); setSaved(false); void save.run(); }} noValidate>
            {d.configured ? <p>Current fee: <Badge tone="info">{(d.bps! / 100).toFixed(2)}%</Badge></p> : <Alert tone="warning">No fee is set yet.</Alert>}
            <ErrorAlert error={save.error} />
            {saved && <Alert tone="success">Fee saved.</Alert>}
            <TextField label="Fee (% of pay)" name="pct" type="number" min={0} max={100} step="0.01" value={pct} onChange={setPct} hint="For example 10 means 10%." />
            <Button type="submit" pending={save.pending} disabled={pct === '' || Number(pct) < 0 || Number(pct) > 100}>Save fee</Button>
          </form>
        )}
      </QueryBoundary>
    </Card>
  );
}

function Generate({ onCreated }: { onCreated: (id: string) => void }) {
  const client = useClient();
  const [q, setQ] = useState('');
  const found = useApi<{ organizations: { id: string; name: string; type: string }[] }>(q.trim().length >= 2 ? '/admin/billing/organizations' : null, { q: q.trim() });
  const [orgId, setOrgId] = useState('');
  const today = new Date();
  const [start, setStart] = useState(new Date(today.getFullYear(), today.getMonth() - 1, 1).toLocaleDateString('en-CA'));
  const [end, setEnd] = useState(new Date(today.getFullYear(), today.getMonth(), 0).toLocaleDateString('en-CA'));
  const preview = useApi<Unbilled>(orgId ? '/admin/billing/unbilled' : null, { organizationId: orgId, periodStart: start, periodEnd: end });
  const create = useAction(async () => { const r = await client.post<{ invoice: { id: string } }>('/admin/billing/invoices', { organizationId: orgId, periodStart: start, periodEnd: end }); onCreated(r.invoice.id); });
  const options = (found.data?.organizations ?? []).map((o) => ({ value: o.id, label: `${o.name} (${o.type})` }));
  return (
    <Card title="Generate an invoice">
      <p className="muted">Collects completed assignments with an approved timesheet whose work ended in the period and that are not already on a live invoice. Billed hours are the approved timesheet hours. The result is a draft that you review before issuing.</p>
      <ErrorAlert error={create.error} />
      <div className="form-grid">
        <TextField label="Find organization" name="orgSearch" value={q} onChange={(v) => { setQ(v); setOrgId(''); }} hint="At least 2 letters of the name." />
        {options.length > 0 && <SelectField label="Organization" name="orgId" value={orgId} onChange={setOrgId} options={options} placeholder="Choose" />}
        <TextField label="Period start" name="periodStart" type="date" value={start} onChange={setStart} />
        <TextField label="Period end" name="periodEnd" type="date" value={end} onChange={setEnd} />
      </div>
      {orgId && (
        <QueryBoundary state={preview}>
          {(d) => (
            <>
              {d.awaitingTimesheet.length > 0 && (
                <Alert tone="warning" title={`${d.awaitingTimesheet.length} shift(s) cannot be billed yet`}>
                  Hours are billed only from an approved timesheet. Waiting: {d.awaitingTimesheet.map((a) => `${a.title} on ${formatDate(a.starts_at)} (${a.timesheet_status ? titleCase(a.timesheet_status) : 'no timesheet'})`).join('; ')}.
                </Alert>
              )}
              {d.items.length === 0 ? <Alert tone="info">Nothing to bill for this organization in that period.</Alert> : (
            <>
              {d.feeBps === null && <Alert tone="warning">Set the platform fee above before generating.</Alert>}
              <DataTable caption="Billable assignments" rows={d.items} rowKey={(i) => i.assignment_id}
                columns={[
                  { header: 'Shift', cell: (i) => `${i.title} · ${formatDate(i.starts_at)}` }, { header: 'Hours', cell: (i) => (i.minutes / 60).toFixed(2) }, { header: 'Rate', cell: (i) => `${money(i.rate_cents)}/h` },
                  { header: 'Pay', cell: (i) => money(i.gross) }, { header: 'Fee', cell: (i) => (i.amount === null ? '—' : money(i.amount)) },
                ]} />
              <p><strong>Invoice total: {d.feeBps === null ? '—' : money(d.items.reduce((s, i) => s + (i.amount ?? 0), 0))}</strong></p>
              <Button pending={create.pending} disabled={d.feeBps === null} onClick={() => void create.run()}>Create draft invoice</Button>
            </>
              )}
            </>
          )}
        </QueryBoundary>
      )}
    </Card>
  );
}

export default function BillingPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ invoices: Inv[]; total: number; pageSize: number }>('/admin/billing/invoices', { status, page });
  return (
    <>
      <PageHeader title="Billing" subtitle="Manual invoicing. Recording a payment here is bookkeeping only: nothing is charged or collected by this system." />
      <Fee />
      <Generate onCreated={(id) => window.location.assign(`/billing/${id}`)} />
      <Card title="Invoices">
        <SelectField label="Status" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All"
          options={['draft', 'issued', 'paid', 'void'].map((s) => ({ value: s, label: titleCase(s) }))} />
        <QueryBoundary state={list}>
          {(d) => d.invoices.length === 0 ? <EmptyState title="No invoices" /> : (
            <>
              <DataTable caption="Invoices" rows={d.invoices} rowKey={(i) => i.id}
                columns={[
                  { header: 'Number', cell: (i) => <Link href={`/billing/${i.id}`}>{i.number ?? 'Draft'}</Link> }, { header: 'Organization', cell: (i) => i.organization_name },
                  { header: 'Period', cell: (i) => `${formatDate(i.period_start)} – ${formatDate(i.period_end)}` }, { header: 'Total', cell: (i) => money(i.total_cents) },
                  { header: 'Status', cell: (i) => <Badge tone={INVOICE_TONE[i.status]}>{titleCase(i.status)}</Badge> }, { header: 'Due', cell: (i) => (i.due_date ? formatDate(i.due_date) : '—') },
                ]} />
              <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}
