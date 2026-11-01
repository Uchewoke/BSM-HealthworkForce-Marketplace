'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, PageHeader, QueryBoundary, TextArea, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { TIMESHEET_TONE, fromLocalInput, hoursText, toLocalInput } from '@/lib/timesheets';

interface Row {
  assignment_id: string; assignment_status: string; title: string; organization_name: string; starts_at: string; ends_at: string; hourly_rate_cents: number;
  id: string | null; status: string | null; worked_start: string | null; worked_end: string | null; break_minutes: number | null; minutes_worked: number | null; note: string | null; review_note: string | null;
}

function Form({ row, reload }: { row: Row; reload: () => Promise<void> }) {
  const client = useClient();
  const [start, setStart] = useState(toLocalInput(row.worked_start ?? row.starts_at));
  const [end, setEnd] = useState(toLocalInput(row.worked_end ?? row.ends_at));
  const [brk, setBrk] = useState(String(row.break_minutes ?? 0));
  const [note, setNote] = useState(row.note ?? '');
  const save = useAction(async () => {
    await client.put(`/professionals/me/assignments/${row.assignment_id}/timesheet`, { workedStart: fromLocalInput(start), workedEnd: fromLocalInput(end), breakMinutes: Number(brk) || 0, note: note.trim() || undefined });
    await reload();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Time you started" name="workedStart" type="datetime-local" required value={start} onChange={setStart} error={save.error} />
        <TextField label="Time you finished" name="workedEnd" type="datetime-local" required value={end} onChange={setEnd} error={save.error} />
        <TextField label="Unpaid break (minutes)" name="breakMinutes" type="number" min={0} max={480} value={brk} onChange={setBrk} error={save.error} />
      </div>
      <TextArea label="Note for the facility (optional)" name="note" value={note} onChange={setNote} rows={2} maxLength={1000} error={save.error} />
      <Button type="submit" pending={save.pending}>{row.status === 'returned' ? 'Resubmit hours' : 'Submit hours'}</Button>
    </form>
  );
}

export default function TimesheetsPage() {
  const list = useApi<{ timesheets: Row[] }>('/professionals/me/timesheets');
  return (
    <>
      <PageHeader title="Timesheets" subtitle="Record the hours you actually worked. The facility approves them, and only approved hours are invoiced." />
      <Alert tone="info">Enter times in your own time zone. Hours that have not happened yet, or that are far from the scheduled shift, are not accepted.</Alert>
      <QueryBoundary state={list}>
        {(d) => d.timesheets.length === 0 ? <EmptyState title="Nothing to record yet">Shifts you have been confirmed for appear here once they start.</EmptyState> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {d.timesheets.map((t) => (
              <li key={t.assignment_id}>
                <Card title={`${t.title} · ${t.organization_name}`} actions={t.status ? <Badge tone={TIMESHEET_TONE[t.status]}>{titleCase(t.status)}</Badge> : <Badge>Not submitted</Badge>}>
                  <p className="muted">Scheduled {formatDateTime(t.starts_at)} – {formatDateTime(t.ends_at)}</p>
                  {t.status === 'returned' && <Alert tone="warning" title="Returned by the facility">{t.review_note}</Alert>}
                  {(t.status === 'submitted' || t.status === 'approved') && t.minutes_worked ? (
                    <p>{t.status === 'approved' ? 'Approved' : 'Waiting for review'}: <strong>{hoursText(t.minutes_worked)}</strong> ({formatDateTime(t.worked_start)} – {formatDateTime(t.worked_end)}, {t.break_minutes} min break)</p>
                  ) : <Form row={t} reload={list.reload} />}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </>
  );
}
