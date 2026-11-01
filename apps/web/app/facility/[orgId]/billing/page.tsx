'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, formatDate, titleCase, useApi } from '@bsm/ui';
import { INVOICE_TONE, money } from '@/lib/billing';
import { useOrg } from '@/lib/org';

interface Inv { id: string; number: string; status: string; period_start: string; period_end: string; total_cents: string; due_date: string | null }

export default function BillingPage() {
  const { org, can } = useOrg();
  const [page, setPage] = useState(1);
  const list = useApi<{ invoices: Inv[]; total: number; pageSize: number }>(can('billing.read') ? `/organizations/${org.id}/billing/invoices` : null, { page });
  if (!can('billing.read')) return <Alert tone="info">Your role cannot view billing. Ask an owner or a finance team member.</Alert>;
  return (
    <>
      <PageHeader title="Billing" subtitle="Invoices from BSM for platform fees on completed assignments." />
      <Alert tone="info">Invoices are issued by BSM staff and paid outside this system. Payment status here is recorded by BSM after it receives payment.</Alert>
      <QueryBoundary state={list}>
        {(d) => d.invoices.length === 0 ? <EmptyState title="No invoices yet">Invoices appear here once BSM issues them.</EmptyState> : (
          <>
            <DataTable caption="Invoices" rows={d.invoices} rowKey={(i) => i.id}
              columns={[
                { header: 'Number', cell: (i) => <Link href={`/facility/${org.id}/billing/${i.id}`}>{i.number}</Link> }, { header: 'Period', cell: (i) => `${formatDate(i.period_start)} – ${formatDate(i.period_end)}` },
                { header: 'Total', cell: (i) => money(i.total_cents) }, { header: 'Status', cell: (i) => <Badge tone={INVOICE_TONE[i.status]}>{titleCase(i.status)}</Badge> }, { header: 'Due', cell: (i) => (i.due_date ? formatDate(i.due_date) : '—') },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
