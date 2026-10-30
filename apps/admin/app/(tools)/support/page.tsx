'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, SelectField, formatDateTime, titleCase, useApi } from '@bsm/ui';

interface T { id: string; category: string; subject: string; status: string; priority: string; assigned_to: string | null; requester_name: string; created_at: string }

export default function AdminSupportPage() {
  const [status, setStatus] = useState('open');
  const [assigned, setAssigned] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const q = useApi<{ tickets: T[]; total: number; pageSize: number }>('/admin/support/tickets', { status, assigned, category, page, pageSize: 20 });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  return (
    <>
      <PageHeader title="Support queue" subtitle="Highest priority first, then oldest." />
      <div className="row">
        <SelectField label="Status" name="status" value={status} onChange={reset(setStatus)} options={['open', 'pending_user', 'resolved', 'closed'].map((s) => ({ value: s, label: titleCase(s) }))} />
        <SelectField label="Assigned" name="assigned" value={assigned} onChange={reset(setAssigned)} placeholder="Anyone" options={[{ value: 'me', label: 'Me' }, { value: 'unassigned', label: 'Unassigned' }]} />
        <SelectField label="Topic" name="category" value={category} onChange={reset(setCategory)} placeholder="All" options={['account', 'credential', 'job', 'application', 'dispute', 'other'].map((s) => ({ value: s, label: titleCase(s) }))} />
      </div>
      <QueryBoundary state={q}>
        {(d) => d.tickets.length === 0 ? <EmptyState title="No requests" /> : (
          <>
            <DataTable caption="Support requests" rows={d.tickets} rowKey={(t) => t.id}
              columns={[
                { header: 'Subject', cell: (t) => <Link href={`/support/${t.id}`}>{t.subject}</Link> }, { header: 'From', cell: (t) => t.requester_name }, { header: 'Topic', cell: (t) => titleCase(t.category) },
                { header: 'Priority', cell: (t) => <Badge tone={t.priority === 'urgent' ? 'danger' : t.priority === 'high' ? 'warning' : 'neutral'}>{titleCase(t.priority)}</Badge> },
                { header: 'Assigned', cell: (t) => (t.assigned_to ? 'Yes' : 'No') }, { header: 'Opened', cell: (t) => formatDateTime(t.created_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
