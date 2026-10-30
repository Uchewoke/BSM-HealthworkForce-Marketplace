'use client';
import Link from 'next/link';
import { useState } from 'react';
import { DataTable, EmptyState, JobStatusBadge, OrgStatusBadge, PageHeader, Pagination, QueryBoundary, SelectField, TextField, formatDateTime, titleCase, useApi } from '@bsm/ui';

interface J { id: string; title: string; status: string; employment_type: string; published_at: string | null; organization_id: string; organization_name: string; organization_status: string; state: string; applications: string }

export default function AdminJobsPage() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ jobs: J[]; total: number; pageSize: number }>('/admin/jobs', { status, q: applied, page, pageSize: 20 });
  return (
    <>
      <PageHeader title="Marketplace oversight" subtitle="All jobs across organizations. Use an intervention only for listings that are misleading, unsafe or against policy." />
      <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); setPage(1); }}>
        <SelectField label="Status" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All" options={['draft', 'published', 'paused', 'filled', 'closed', 'cancelled'].map((s) => ({ value: s, label: titleCase(s) }))} />
        <TextField label="Job or organization" name="q" type="search" value={q} onChange={setQ} />
        <button type="submit" className="btn">Search</button>
      </form>
      <QueryBoundary state={list}>
        {(d) => d.jobs.length === 0 ? <EmptyState title="No jobs match" /> : (
          <>
            <DataTable caption="Jobs" rows={d.jobs} rowKey={(j) => j.id}
              columns={[
                { header: 'Job', cell: (j) => <Link href={`/jobs/${j.id}`}>{j.title}</Link> }, { header: 'Status', cell: (j) => <JobStatusBadge status={j.status} /> },
                { header: 'Organization', cell: (j) => <><Link href={`/organizations/${j.organization_id}`}>{j.organization_name}</Link> <OrgStatusBadge status={j.organization_status} /></> },
                { header: 'Type', cell: (j) => titleCase(j.employment_type) }, { header: 'State', cell: (j) => j.state }, { header: 'Applications', cell: (j) => j.applications },
                { header: 'Published', cell: (j) => formatDateTime(j.published_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
