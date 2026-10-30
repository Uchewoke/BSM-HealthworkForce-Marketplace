'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, DataTable, EmptyState, JobStatusBadge, LinkButton, PageHeader, Pagination, QueryBoundary, SelectField, formatDateTime, formatPay, titleCase, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface J { id: string; title: string; status: string; employment_type: string; pay_unit: string; pay_min_cents: number | null; pay_max_cents: number | null; city: string; state: string; open_upcoming_shifts: string; updated_at: string }

export default function JobsPage() {
  const { org, approved, can } = useOrg();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ jobs: J[]; total: number; pageSize: number }>(approved ? `/organizations/${org.id}/jobs` : null, { status, page, pageSize: 20 });
  return (
    <>
      <PageHeader title="Jobs & shifts" actions={approved && can('jobs.manage') ? <LinkButton href={`/facility/${org.id}/jobs/new`}>New job</LinkButton> : undefined} />
      {!approved && <Alert tone="info">You can create and publish jobs once BSM approves your organization.</Alert>}
      {approved && (
        <>
          <SelectField label="Show" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All statuses"
            options={['draft', 'published', 'paused', 'filled', 'closed', 'cancelled'].map((s) => ({ value: s, label: titleCase(s) }))} />
          <QueryBoundary state={list}>
            {(d) => d.jobs.length === 0 ? <EmptyState title="No jobs yet" action={can('jobs.manage') ? <LinkButton href={`/facility/${org.id}/jobs/new`}>Create your first job</LinkButton> : undefined} /> : (
              <>
                <DataTable caption="Jobs" rows={d.jobs} rowKey={(j) => j.id}
                  columns={[
                    { header: 'Title', cell: (j) => <Link href={`/facility/${org.id}/jobs/${j.id}`}>{j.title}</Link> }, { header: 'Status', cell: (j) => <JobStatusBadge status={j.status} /> },
                    { header: 'Type', cell: (j) => titleCase(j.employment_type) }, { header: 'Location', cell: (j) => `${j.city}, ${j.state}` },
                    { header: 'Pay', cell: (j) => formatPay(j.pay_unit, j.pay_min_cents, j.pay_max_cents) },
                    { header: 'Upcoming open shifts', cell: (j) => (j.employment_type === 'permanent' ? '—' : j.open_upcoming_shifts) }, { header: 'Updated', cell: (j) => formatDateTime(j.updated_at) },
                  ]} />
                <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
              </>
            )}
          </QueryBoundary>
        </>
      )}
    </>
  );
}
