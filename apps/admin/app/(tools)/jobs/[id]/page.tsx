'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Card, ConfirmButton, DataTable, DefinitionList, ErrorAlert, JobStatusBadge, PageHeader, QueryBoundary, SelectField, TextArea, Timeline, formatDateTime, formatPay, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Detail {
  job: { id: string; title: string; description: string; status: string; employment_type: string; pay_unit: string; pay_min_cents: number | null; pay_max_cents: number | null; organization_id: string; organization_name: string; organization_status: string; city: string; state: string };
  requirements: { kind: string; credential_type: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }[];
  shifts: { id: string; starts_at: string; ends_at: string; positions: number; status: string }[];
  history: { from_status: string | null; to_status: string; reason: string | null; created_at: string }[];
  applications: Record<string, number>;
}

function Intervene({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const options = (['paused', 'closed', 'cancelled'] as const).filter((t) => (d.job.status === 'published' ? true : d.job.status === 'paused' ? t !== 'paused' : d.job.status === 'draft' ? t === 'cancelled' : false));
  const [to, setTo] = useState<string>(options[0] ?? '');
  const [reason, setReason] = useState('');
  const act = useAction(async () => { await client.post(`/admin/jobs/${d.job.id}/status`, { to: to || options[0], reason }); setReason(''); await reload(); });
  if (options.length === 0) return <p className="muted">No intervention is possible for a {d.job.status} job.</p>;
  return (
    <form onSubmit={(e) => e.preventDefault()} noValidate>
      <ErrorAlert error={act.error} />
      <Alert tone="warning">The organization’s job managers are notified with your reason. Pausing is reversible by the organization; closing and cancelling are not.</Alert>
      <SelectField label="Action" name="to" value={to || options[0]!} onChange={setTo} options={options.map((o) => ({ value: o, label: titleCase(o) }))} />
      <TextArea label="Reason (shown to the organization, required)" name="reason" value={reason} onChange={setReason} rows={3} maxLength={1000} />
      {reason.trim().length < 3 ? <button className="btn secondary" disabled>Apply</button>
        : <ConfirmButton label={`${titleCase(to || options[0])} this job`} message={`${titleCase(to || options[0])} “${d.job.title}” for ${d.job.organization_name}?`} pending={act.pending} onConfirm={() => act.run()} />}
    </form>
  );
}

export default function AdminJobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/admin/jobs/${id}`);
  return (
    <>
      <p><Link href="/jobs">← All jobs</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.job.title} subtitle={<><Link href={`/organizations/${d.job.organization_id}`}>{d.job.organization_name}</Link> · <JobStatusBadge status={d.job.status} /></>} />
            <Card title="Intervene"><Intervene d={d} reload={state.reload} /></Card>
            <Card title="Listing">
              <p style={{ whiteSpace: 'pre-wrap' }}>{d.job.description}</p>
              <DefinitionList items={[['Type', titleCase(d.job.employment_type)], ['Location', `${d.job.city}, ${d.job.state}`], ['Pay', formatPay(d.job.pay_unit, d.job.pay_min_cents, d.job.pay_max_cents)],
                ['Applications', Object.entries(d.applications).map(([k, n]) => `${titleCase(k)}: ${n}`).join(', ') || 'None']]} />
            </Card>
            <Card title="Requirements">
              <DataTable caption="Requirements" rows={d.requirements} rowKey={(r) => `${r.kind}-${r.credential_type}-${r.jurisdiction}-${r.description}`} empty={<p className="muted">None listed.</p>}
                columns={[{ header: 'Kind', cell: (r) => titleCase(r.kind) }, { header: 'Detail', cell: (r) => r.credential_type ?? r.description }, { header: 'State', cell: (r) => r.jurisdiction ?? '—' }, { header: 'Mandatory', cell: (r) => (r.mandatory ? 'Yes' : 'No') }]} />
            </Card>
            <Card title="Shifts">
              <DataTable caption="Shifts" rows={d.shifts} rowKey={(s) => s.id} empty={<p className="muted">None.</p>}
                columns={[{ header: 'Starts', cell: (s) => formatDateTime(s.starts_at) }, { header: 'Ends', cell: (s) => formatDateTime(s.ends_at) }, { header: 'Needed', cell: (s) => s.positions }, { header: 'Status', cell: (s) => titleCase(s.status) }]} />
            </Card>
            <Card title="History"><Timeline items={d.history.map((h, i) => ({ key: String(i), at: h.created_at, title: h.from_status ? `${titleCase(h.from_status)} → ${titleCase(h.to_status)}` : `Created as ${titleCase(h.to_status)}`, detail: h.reason ?? undefined }))} /></Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
