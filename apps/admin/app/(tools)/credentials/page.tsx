'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, SelectField, formatDate, formatDateTime, titleCase, useApi } from '@bsm/ui';

interface C { id: string; kind: string; credential_type: string; jurisdiction: string | null; expiration_date: string | null; status: string; updated_at: string; professional_name: string }
const STATUSES = ['submitted', 'pending_review', 'needs_more_information', 'unable_to_verify', 'verified', 'rejected', 'revoked', 'not_submitted'];

export default function CredentialQueuePage() {
  const [status, setStatus] = useState('submitted');
  const [page, setPage] = useState(1);
  const q = useApi<{ credentials: C[]; total: number; pageSize: number }>('/admin/credentials', { status, page, pageSize: 20, order: 'asc' });
  return (
    <>
      <PageHeader title="Credential review" subtitle="Oldest first. Submitted items need to be picked up; pending items need a decision." />
      <SelectField label="Queue" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
      <QueryBoundary state={q}>
        {(d) => d.credentials.length === 0 ? <EmptyState title={`No credentials are ${titleCase(status).toLowerCase()}`} /> : (
          <>
            <DataTable caption="Credentials" rows={d.credentials} rowKey={(c) => c.id}
              columns={[
                { header: 'Credential', cell: (c) => <Link href={`/credentials/${c.id}`}>{c.credential_type}{c.jurisdiction ? ` (${c.jurisdiction})` : ''}</Link> }, { header: 'Kind', cell: (c) => titleCase(c.kind) },
                { header: 'Professional', cell: (c) => c.professional_name }, { header: 'Expires', cell: (c) => formatDate(c.expiration_date) },
                { header: 'Status', cell: (c) => <Badge tone={c.status === 'verified' ? 'success' : 'info'}>{titleCase(c.status)}</Badge> }, { header: 'Waiting since', cell: (c) => formatDateTime(c.updated_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
