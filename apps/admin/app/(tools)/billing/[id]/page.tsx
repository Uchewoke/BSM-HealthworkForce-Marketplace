'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmButton, DataTable, DefinitionList, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextField, formatDate, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { INVOICE_TONE, money } from '@/lib/billing';

interface Detail {
  invoice: { id: string; organization_id: string; organization_name: string; number: string | null; status: string; period_start: string; period_end: string; fee_bps: number; total_cents: string; due_date: string | null; issued_at: string | null; paid_at: string | null; payment_method: string | null; payment_reference: string | null; void_reason: string | null };
  lines: { id: string; description: string; minutes: number; rate_cents: number; gross_cents: string; amount_cents: string; voided: boolean }[];
}
const METHODS = [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'check', label: 'Check' }, { value: 'card_offline', label: 'Card (taken outside this system)' }, { value: 'other', label: 'Other' }];

function Actions({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const id = d.invoice.id;
  const [dueInDays, setDue] = useState('30');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const issue = useAction(async () => { await client.post(`/admin/billing/invoices/${id}/issue`, { dueInDays: Number(dueInDays) }); await reload(); });
  const pay = useAction(async () => { await client.post(`/admin/billing/invoices/${id}/payment`, { method, reference }); await reload(); });
  const doVoid = useAction(async () => { await client.post(`/admin/billing/invoices/${id}/void`, { reason }); await reload(); });
  const s = d.invoice.status;
  if (s === 'paid' || s === 'void') return <Alert tone="info">This invoice is {s} and can no longer be changed.</Alert>;
  return (
    <>
      <ErrorAlert error={issue.error ?? pay.error ?? doVoid.error} />
      {s === 'draft' && (
        <Card title="Issue">
          <p className="muted">Issuing assigns the invoice number and notifies the organization’s billing contacts. Check the lines first: an issued invoice can be voided but not edited.</p>
          <TextField label="Payment due in (days)" name="dueInDays" type="number" min={0} max={120} value={dueInDays} onChange={setDue} />
          <ConfirmButton tone="primary" label="Issue invoice" message="Issue this invoice and notify the organization?" pending={issue.pending} onConfirm={() => issue.run()} />
        </Card>
      )}
      {s === 'issued' && (
        <Card title="Record a payment">
          <Alert tone="info">Only record a payment you have actually received. This does not charge anyone.</Alert>
          <div className="form-grid">
            <SelectField label="Method" name="method" value={method} onChange={setMethod} options={METHODS} />
            <TextField label="Reference" name="reference" required value={reference} onChange={setReference} hint="Transfer, check or receipt number." error={pay.error} />
          </div>
          <Button pending={pay.pending} disabled={reference.trim().length < 2} onClick={() => void pay.run()}>Mark as paid</Button>
        </Card>
      )}
      <Card title="Void">
        <p className="muted">Voiding releases the assignments on this invoice so they can be billed again.</p>
        <TextField label="Reason (required)" name="reason" value={reason} onChange={setReason} maxLength={1000} />
        {reason.trim().length < 3 ? <Button tone="secondary" disabled>Void invoice</Button> : <ConfirmButton label="Void invoice" message="Void this invoice? This cannot be undone." pending={doVoid.pending} onConfirm={() => doVoid.run()} />}
      </Card>
    </>
  );
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/admin/billing/invoices/${id}`);
  return (
    <>
      <p><Link href="/billing">← Billing</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.invoice.number ?? 'Draft invoice'} subtitle={<><Badge tone={INVOICE_TONE[d.invoice.status]}>{titleCase(d.invoice.status)}</Badge> · {d.invoice.organization_name}</>} />
            <Card title="Summary">
              <DefinitionList items={[
                ['Organization', <Link key="o" href={`/organizations/${d.invoice.organization_id}`}>{d.invoice.organization_name}</Link>], ['Period', `${formatDate(d.invoice.period_start)} – ${formatDate(d.invoice.period_end)}`],
                ['Fee rate', `${(d.invoice.fee_bps / 100).toFixed(2)}%`], ['Total', <strong key="t">{money(d.invoice.total_cents)}</strong>],
                ['Issued', d.invoice.issued_at ? formatDateTime(d.invoice.issued_at) : '—'], ['Due', d.invoice.due_date ? formatDate(d.invoice.due_date) : '—'],
                ['Paid', d.invoice.paid_at ? `${formatDateTime(d.invoice.paid_at)} · ${titleCase(d.invoice.payment_method ?? '')} · ${d.invoice.payment_reference}` : '—'],
                ...(d.invoice.void_reason ? [['Void reason', d.invoice.void_reason] as [string, string]] : []),
              ]} />
            </Card>
            <Card title="Lines">
              <DataTable caption="Invoice lines" rows={d.lines} rowKey={(l) => l.id}
                columns={[
                  { header: 'Description', cell: (l) => l.description }, { header: 'Hours', cell: (l) => (l.minutes / 60).toFixed(2) }, { header: 'Rate', cell: (l) => `${money(l.rate_cents)}/h` },
                  { header: 'Pay', cell: (l) => money(l.gross_cents) }, { header: 'Fee', cell: (l) => money(l.amount_cents) },
                ]} />
              <p className="small muted">Hours come from the approved timesheet for each shift.</p>
            </Card>
            <Actions d={d} reload={state.reload} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
