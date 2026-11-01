'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, Badge, Card, DataTable, DefinitionList, PageHeader, QueryBoundary, formatDate, formatDateTime, titleCase, useApi } from '@bsm/ui';
import { INVOICE_TONE, money } from '@/lib/billing';
import { useOrg } from '@/lib/org';

interface Detail {
  invoice: { number: string; status: string; period_start: string; period_end: string; fee_bps: number; total_cents: string; due_date: string | null; issued_at: string | null; paid_at: string | null; payment_method: string | null; payment_reference: string | null; void_reason: string | null };
  lines: { id: string; description: string; minutes: number; rate_cents: number; gross_cents: string; amount_cents: string; voided: boolean }[];
}

export default function InvoiceDetailPage() {
  const { org, can } = useOrg();
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(can('billing.read') ? `/organizations/${org.id}/billing/invoices/${id}` : null);
  if (!can('billing.read')) return <Alert tone="info">Your role cannot view billing.</Alert>;
  return (
    <>
      <p><Link href={`/facility/${org.id}/billing`}>← All invoices</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.invoice.number} subtitle={<Badge tone={INVOICE_TONE[d.invoice.status]}>{titleCase(d.invoice.status)}</Badge>} />
            {d.invoice.status === 'void' && <Alert tone="warning" title="This invoice was voided">{d.invoice.void_reason}</Alert>}
            <Card title="Summary">
              <DefinitionList items={[
                ['Period', `${formatDate(d.invoice.period_start)} – ${formatDate(d.invoice.period_end)}`], ['Fee rate', `${(d.invoice.fee_bps / 100).toFixed(2)}% of pay`],
                ['Total', <strong key="t">{money(d.invoice.total_cents)}</strong>], ['Issued', d.invoice.issued_at ? formatDateTime(d.invoice.issued_at) : '—'], ['Due', d.invoice.due_date ? formatDate(d.invoice.due_date) : '—'],
                ['Payment', d.invoice.paid_at ? `Received ${formatDateTime(d.invoice.paid_at)} · ${titleCase(d.invoice.payment_method ?? '')} · ${d.invoice.payment_reference}` : 'Not yet recorded'],
              ]} />
            </Card>
            <Card title="Lines">
              <DataTable caption="Invoice lines" rows={d.lines} rowKey={(l) => l.id}
                columns={[
                  { header: 'Description', cell: (l) => l.description }, { header: 'Hours', cell: (l) => (l.minutes / 60).toFixed(2) }, { header: 'Pay rate', cell: (l) => `${money(l.rate_cents)}/h` },
                  { header: 'Pay', cell: (l) => money(l.gross_cents) }, { header: 'Fee', cell: (l) => money(l.amount_cents) },
                ]} />
              <p className="small muted">Hours are the approved timesheet hours. Questions about an invoice? Contact support from the Support page.</p>
            </Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
