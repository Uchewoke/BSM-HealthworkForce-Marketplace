'use client';
import { useState } from 'react';
import { Alert, Card, DataTable, EmptyState, PageHeader, Pagination, QueryBoundary, TextField, formatDateTime, useApi } from '@bsm/ui';

interface L { id: string; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; organization_id: string | null; request_id: string | null; metadata: Record<string, unknown>; created_at: string }
const EMPTY = { actorEmail: '', action: '', targetType: '', targetId: '', organizationId: '', from: '', to: '' };

export default function AuditPage() {
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const res = useApi<{ auditLogs: L[]; total: number; pageSize: number }>('/admin/audit-logs', {
    ...applied, from: applied.from ? new Date(applied.from).toISOString() : undefined, to: applied.to ? new Date(applied.to).toISOString() : undefined, page, pageSize: 50,
  });
  const set = (k: keyof typeof EMPTY) => (v: string) => setDraft({ ...draft, [k]: v });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of sign-ins, reviews, decisions and administrative actions." />
      <Alert tone="info">Reading this log is itself recorded (filters only). The log cannot be edited or deleted.</Alert>
      <Card>
        <form role="search" onSubmit={(e) => { e.preventDefault(); setApplied(draft); setPage(1); }}>
          <div className="form-grid">
            <TextField label="Actor email" name="actorEmail" type="email" value={draft.actorEmail} onChange={set('actorEmail')} />
            <TextField label="Action starts with" name="action" value={draft.action} onChange={set('action')} hint="e.g. credential. or job.status." />
            <TextField label="Target type" name="targetType" value={draft.targetType} onChange={set('targetType')} hint="e.g. job, credential, user" />
            <TextField label="Target id" name="targetId" value={draft.targetId} onChange={set('targetId')} />
            <TextField label="Organization id" name="organizationId" value={draft.organizationId} onChange={set('organizationId')} />
            <TextField label="From" name="from" type="datetime-local" value={draft.from} onChange={set('from')} />
            <TextField label="To" name="to" type="datetime-local" value={draft.to} onChange={set('to')} />
          </div>
          <div className="row"><button type="submit" className="btn">Search</button><button type="button" className="btn secondary" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); setPage(1); }}>Clear</button></div>
        </form>
      </Card>
      <QueryBoundary state={res}>
        {(d) => d.auditLogs.length === 0 ? <EmptyState title="No entries match" /> : (
          <>
            <p className="muted" aria-live="polite">{d.total} entries</p>
            <DataTable caption="Audit entries" rows={d.auditLogs} rowKey={(l) => l.id}
              columns={[
                { header: 'When', cell: (l) => formatDateTime(l.created_at) }, { header: 'Actor', cell: (l) => l.actor_email ?? 'system / anonymous' }, { header: 'Action', cell: (l) => <code>{l.action}</code> },
                { header: 'Target', cell: (l) => [l.target_type, l.target_id].filter(Boolean).join(' ') || '—' },
                { header: 'Details', cell: (l) => (Object.keys(l.metadata ?? {}).length ? <code className="small">{JSON.stringify(l.metadata)}</code> : '—') },
                { header: 'Request', cell: (l) => <span className="small muted">{l.request_id?.slice(0, 8) ?? '—'}</span> },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
