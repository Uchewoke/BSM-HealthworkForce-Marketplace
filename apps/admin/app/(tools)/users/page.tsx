'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Card, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, TextField, formatDateTime, titleCase, useApi } from '@bsm/ui';

interface U { id: string; email: string; full_name: string; status: string; platform_role: string | null; email_verified_at: string | null; created_at: string }

export default function UsersPage() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const res = useApi<{ users: U[]; total: number; pageSize: number }>(applied.length >= 2 ? '/admin/users' : null, { q: applied, page, pageSize: 20 });
  return (
    <>
      <PageHeader title="Users" subtitle="Search by name or email address." />
      <Alert tone="info">Searches and profile views are recorded in the audit log (the search text itself is not stored). Look up only what you need for a support or review task.</Alert>
      <Card>
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); setPage(1); }}>
          <TextField label="Name or email" name="q" type="search" value={q} onChange={setQ} hint="At least 2 characters" />
          <button type="submit" className="btn" disabled={q.trim().length < 2}>Search</button>
        </form>
      </Card>
      {applied.length >= 2 && (
        <QueryBoundary state={res}>
          {(d) => d.users.length === 0 ? <EmptyState title="No users match" /> : (
            <>
              <p className="muted" aria-live="polite">{d.total} found</p>
              <DataTable caption="Users" rows={d.users} rowKey={(u) => u.id}
                columns={[
                  { header: 'Name', cell: (u) => <Link href={`/users/${u.id}`}>{u.full_name}</Link> }, { header: 'Email', cell: (u) => u.email },
                  { header: 'Status', cell: (u) => <Badge tone={u.status === 'active' ? 'success' : 'danger'}>{titleCase(u.status)}</Badge> },
                  { header: 'Staff role', cell: (u) => (u.platform_role ? titleCase(u.platform_role) : '—') }, { header: 'Joined', cell: (u) => formatDateTime(u.created_at) },
                ]} />
              <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </QueryBoundary>
      )}
    </>
  );
}
