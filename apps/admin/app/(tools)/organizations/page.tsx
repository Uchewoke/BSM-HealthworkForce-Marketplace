'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Card, DataTable, EmptyState, OrgStatusBadge, PageHeader, Pagination, QueryBoundary, SelectField, TextField, formatDateTime, titleCase, useApi } from '@bsm/ui';

interface O { id: string; name: string; legal_name: string | null; state: string | null; status: string; created_at: string; updated_at: string }
const STATUSES = ['submitted', 'under_review', 'needs_information', 'approved', 'rejected', 'suspended', 'draft'];

function Lookup() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const res = useApi<{ organizations: (O & { type: string })[] }>(applied.length >= 2 ? '/admin/organization-lookup' : null, { q: applied });
  return (
    <Card title="Find an organization (any status)">
      <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); }}>
        <TextField label="Name" name="q" type="search" value={q} onChange={setQ} hint="At least 2 characters" />
        <button type="submit" className="btn" disabled={q.trim().length < 2}>Search</button>
      </form>
      {res.data && (
        <DataTable caption="Organizations found" rows={res.data.organizations} rowKey={(o) => o.id} empty={<p className="muted">No organization matches.</p>}
          columns={[{ header: 'Name', cell: (o) => <Link href={`/organizations/${o.id}`}>{o.name}</Link> }, { header: 'Legal name', cell: (o) => o.legal_name ?? '—' }, { header: 'Status', cell: (o) => <OrgStatusBadge status={o.status} /> }]} />
      )}
    </Card>
  );
}

export default function OrganizationsPage() {
  const [status, setStatus] = useState('submitted');
  const [page, setPage] = useState(1);
  const q = useApi<{ organizations: O[]; total: number; pageSize: number }>('/admin/organizations', { status, page, pageSize: 20, order: 'asc', sort: 'updated_at' });
  return (
    <>
      <PageHeader title="Facility review" subtitle="Oldest first. Open an organization to review its details and record a decision." />
      <SelectField label="Queue" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
      <QueryBoundary state={q}>
        {(d) => d.organizations.length === 0 ? <EmptyState title={`Nothing is ${titleCase(status).toLowerCase()}`} /> : (
          <>
            <DataTable caption="Organizations awaiting action" rows={d.organizations} rowKey={(o) => o.id}
              columns={[
                { header: 'Organization', cell: (o) => <Link href={`/organizations/${o.id}`}>{o.name}</Link> }, { header: 'Legal name', cell: (o) => o.legal_name ?? '—' }, { header: 'State', cell: (o) => o.state ?? '—' },
                { header: 'Status', cell: (o) => <OrgStatusBadge status={o.status} /> }, { header: 'Created', cell: (o) => formatDateTime(o.created_at) }, { header: 'Last change', cell: (o) => formatDateTime(o.updated_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
      <Lookup />
    </>
  );
}
