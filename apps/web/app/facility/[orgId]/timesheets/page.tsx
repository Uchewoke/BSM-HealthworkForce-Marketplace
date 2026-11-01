'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { TIMESHEET_TONE, hoursText } from '@/lib/timesheets';
import { useOrg } from '@/lib/org';

interface Row {
  id: string; status: string; worked_start: string; worked_end: string; break_minutes: number; minutes_worked: number; note: string | null; submitted_at: string; review_note: string | null;
  title: string; starts_at: string; ends_at: string; hourly_rate_cents: number; professional_name: string;
}

function Review({ row, orgId, reload }: { row: Row; orgId: string; reload: () => Promise<void> }) {
  const client = useClient();
  const [reason, setReason] = useState('');
  const act = useAction(async (decision: 'approve' | 'return') => { await client.post(`/organizations/${orgId}/timesheets/${row.id}/review`, { decision, reason: decision === 'return' ? reason : undefined }); setReason(''); await reload(); });
  const scheduled = Math.round((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60_000);
  const diff = row.minutes_worked - scheduled;
  return (
    <Card title={`${row.professional_name} · ${row.title}`}>
      <p className="muted">Scheduled {formatDateTime(row.starts_at)} – {formatDateTime(row.ends_at)} ({hoursText(scheduled)})</p>
      <p>
        Worked {formatDateTime(row.worked_start)} – {formatDateTime(row.worked_end)}, {row.break_minutes} min break → <strong>{hoursText(row.minutes_worked)}</strong>
        {diff !== 0 && <> <Badge tone="warning">{diff > 0 ? '+' : '−'}{hoursText(Math.abs(diff))} vs schedule</Badge></>}
      </p>
      {row.note && <p>Note: "{row.note}"</p>}
      <ErrorAlert error={act.error} />
      <TextField label="Reason (required to return it)" name="reason" value={reason} onChange={setReason} maxLength={1000} />
      <div className="row">
        <Button pending={act.pending} onClick={() => void act.run('approve')}>Approve hours</Button>
        <Button tone="secondary" pending={act.pending} disabled={reason.trim().length < 3} onClick={() => void act.run('return')}>Return for correction</Button>
      </div>
    </Card>
  );
}

export default function TimesheetsPage() {
  const { org, can } = useOrg();
  const [status, setStatus] = useState('submitted');
  const [page, setPage] = useState(1);
  const list = useApi<{ timesheets: Row[]; total: number; pageSize: number }>(`/organizations/${org.id}/timesheets`, { status, page });
  return (
    <>
      <PageHeader title="Timesheets" subtitle="Hours submitted by professionals. Approving hours records them for invoicing and marks the assignment completed." />
      {!can('applications.manage') && <Alert tone="info">Your role can view timesheets but not approve them.</Alert>}
      <SelectField label="Status" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['submitted', 'returned', 'approved'].map((s) => ({ value: s, label: titleCase(s) }))} />
      <QueryBoundary state={list}>
        {(d) => d.timesheets.length === 0 ? <EmptyState title={`No ${status} timesheets`} /> : (
          <>
            {status === 'submitted' && can('applications.manage')
              ? <ul style={{ listStyle: 'none', padding: 0 }}>{d.timesheets.map((t) => <li key={t.id}><Review row={t} orgId={org.id} reload={list.reload} /></li>)}</ul>
              : (
                <DataTable caption="Timesheets" rows={d.timesheets} rowKey={(t) => t.id}
                  columns={[
                    { header: 'Professional', cell: (t) => t.professional_name }, { header: 'Shift', cell: (t) => `${t.title} · ${formatDateTime(t.starts_at)}` },
                    { header: 'Hours', cell: (t) => hoursText(t.minutes_worked) }, { header: 'Status', cell: (t) => <Badge tone={TIMESHEET_TONE[t.status]}>{titleCase(t.status)}</Badge> },
                    { header: 'Review note', cell: (t) => t.review_note ?? '—' },
                  ]} />
              )}
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
