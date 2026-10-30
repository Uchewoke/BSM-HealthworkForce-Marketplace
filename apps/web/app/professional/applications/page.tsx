'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ApplicationStatusBadge, DataTable, EmptyState, LinkButton, PageHeader, Pagination, QueryBoundary, formatDateTime, titleCase, useApi } from '@bsm/ui';

interface A { id: string; status: string; title: string; employment_type: string; organization_name: string; city: string; state: string; updated_at: string }

export default function ApplicationsPage() {
  const [page, setPage] = useState(1);
  const list = useApi<{ applications: A[]; total: number; pageSize: number }>('/professionals/me/applications', { page });
  return (
    <>
      <PageHeader title="My applications" />
      <QueryBoundary state={list}>
        {(d) => d.applications.length === 0 ? <EmptyState title="You haven’t applied to anything yet" action={<LinkButton href="/professional/jobs">Find jobs</LinkButton>} /> : (
          <>
            <DataTable caption="Your applications" rows={d.applications} rowKey={(a) => a.id}
              columns={[
                { header: 'Job', cell: (a) => <Link href={`/professional/applications/${a.id}`}>{a.title}</Link> },
                { header: 'Facility', cell: (a) => `${a.organization_name} · ${a.city}, ${a.state}` }, { header: 'Type', cell: (a) => titleCase(a.employment_type) },
                { header: 'Status', cell: (a) => <ApplicationStatusBadge status={a.status} /> }, { header: 'Updated', cell: (a) => formatDateTime(a.updated_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
