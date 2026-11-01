'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Alert, Badge, Button, Card, CheckField, ConfirmButton, DataTable, ErrorAlert, JobStatusBadge, LinkButton, PageHeader, QueryBoundary, SelectField, TextArea, TextField, Timeline,
  US_STATE_CODES, formatDateTime, titleCase, useAction, useApi, useClient, zonedTimeToIso,
} from '@bsm/ui';
import { AgencyAccess } from '@/components/AgencyAccess';
import { JobForm, type JobData } from '@/components/JobForm';
import { useLocations, useOrg } from '@/lib/org';

interface Req { id?: string; kind: string; credential_type: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }
interface Shift { id: string; starts_at: string; ends_at: string; positions: number; hourly_rate_cents: number | null; notes: string | null; status: string }
interface Detail { job: JobData & { id: string }; requirements: Req[]; shifts: Shift[]; history: { from_status: string | null; to_status: string; reason: string | null; created_at: string }[] }

const MISSING: Record<string, string> = {
  description: 'Add a description of at least 20 characters.', applicationDeadline: 'The application deadline must be in the future.', references: 'The location, department, profession or specialty is no longer valid.',
  requirements: 'List at least one mandatory license or certification, or state that the job has none.', requirements_conflict: 'You said the job has no credential requirements but listed mandatory ones. Fix one of them.',
  shifts: 'Add at least one upcoming shift.', state_not_enabled: 'BSM has not enabled listings in this location’s state yet.',
};
const TRANSITIONS: Record<string, { to: string; label: string; needsReason?: boolean; publish?: boolean; danger?: boolean }[]> = {
  draft: [{ to: 'published', label: 'Publish', publish: true }, { to: 'cancelled', label: 'Cancel job', needsReason: true, danger: true }],
  published: [{ to: 'paused', label: 'Pause' }, { to: 'filled', label: 'Mark as filled' }, { to: 'closed', label: 'Close', needsReason: true, danger: true }, { to: 'cancelled', label: 'Cancel job', needsReason: true, danger: true }],
  paused: [{ to: 'published', label: 'Resume', publish: true }, { to: 'closed', label: 'Close', needsReason: true, danger: true }, { to: 'cancelled', label: 'Cancel job', needsReason: true, danger: true }],
};

function Lifecycle({ orgId, d, reload }: { orgId: string; d: Detail; reload: () => Promise<void> }) {
  const { can } = useOrg();
  const client = useClient();
  const [reason, setReason] = useState('');
  const move = useAction(async (to: string) => { await client.post(`/organizations/${orgId}/jobs/${d.job.id}/status`, { to, reason: reason || undefined }); setReason(''); await reload(); });
  const options = (TRANSITIONS[d.job.status ?? 'draft'] ?? []).filter((t) => !t.publish || can('jobs.publish'));
  const missing: string[] | undefined = move.error?.details?.missing;
  return (
    <Card title="Status">
      <p>This job is <JobStatusBadge status={d.job.status ?? 'draft'} />. {d.job.status === 'draft' && 'It is not visible to professionals yet.'}{d.job.status === 'published' && 'Professionals can find it and apply.'}{d.job.status === 'paused' && 'It is hidden from search until you resume it.'}</p>
      {missing && <Alert tone="warning" title="Before this job can be published">
        <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{missing.map((m) => <li key={m}>{MISSING[m] ?? m}</li>)}</ul></Alert>}
      {move.error && !missing && <ErrorAlert error={move.error} />}
      {d.job.status === 'draft' && !can('jobs.publish') && <Alert tone="info">Your role can prepare jobs but cannot publish them. Ask a hiring manager or admin to publish.</Alert>}
      {options.length === 0 ? <p className="muted">No further changes are possible for a {d.job.status} job.</p> : (
        <>
          {options.some((o) => o.needsReason) && <TextField label="Reason (required to close or cancel)" name="reason" value={reason} onChange={setReason} maxLength={1000} />}
          <div className="row">
            {options.map((o) => !(o.needsReason || o.danger)
              ? <Button key={o.to} pending={move.pending} onClick={() => void move.run(o.to)}>{o.label}</Button>
              : reason.trim().length < 3
                ? <Button key={o.to} tone="secondary" disabled aria-describedby="reason-needed">{o.label}</Button>
                : <ConfirmButton key={o.to} label={o.label} message={`${o.label}? ${o.to === 'closed' || o.to === 'cancelled' ? 'Open shifts will be cancelled and this cannot be undone.' : ''}`} pending={move.pending} onConfirm={() => move.run(o.to)} />)}
          </div>
          {options.some((o) => o.needsReason) && reason.trim().length < 3 && <p id="reason-needed" className="small muted">Enter a reason to enable closing or cancelling.</p>}
        </>
      )}
    </Card>
  );
}

function Requirements({ orgId, d, reload }: { orgId: string; d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const draft = d.job.status === 'draft';
  const [rows, setRows] = useState<Req[]>(d.requirements);
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    await client.put(`/organizations/${orgId}/jobs/${d.job.id}/requirements`, {
      requirements: rows.map((r) => ({ kind: r.kind, credentialType: r.credential_type || undefined, jurisdiction: r.jurisdiction || undefined, description: r.description || undefined, mandatory: r.mandatory })),
    });
    setSaved(true); await reload();
  });
  const upd = (i: number, p: Partial<Req>) => { setSaved(false); setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r))); };
  return (
    <Card title="Requirements">
      <p className="muted">Mandatory items must be verified and unexpired before an applicant can receive an offer. Preferred items are shown to applicants but do not decide eligibility.</p>
      {!draft && <Alert tone="info">Requirements are locked once a job is published so applicants are judged on what they applied for.</Alert>}
      <ErrorAlert error={save.error} />
      {saved && <Alert tone="success">Requirements saved.</Alert>}
      <fieldset disabled={!draft} style={{ border: 0, padding: 0 }}>
        {rows.map((r, i) => (
          <div key={i} className="card" style={{ background: 'var(--bg)' }}>
            <div className="form-grid">
              <SelectField label="Kind" name={`kind-${i}`} value={r.kind} onChange={(v) => upd(i, { kind: v })} options={[{ value: 'license', label: 'License' }, { value: 'certification', label: 'Certification' }, { value: 'other', label: 'Other (checked by a person)' }]} />
              {r.kind !== 'other' && <TextField label="Credential type" name={`type-${i}`} value={r.credential_type ?? ''} onChange={(v) => upd(i, { credential_type: v })} hint="Must match the professional’s credential type, e.g. RN or BLS." />}
              {r.kind === 'license' && <SelectField label="State" name={`state-${i}`} value={r.jurisdiction ?? ''} onChange={(v) => upd(i, { jurisdiction: v })} placeholder="—" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} />}
              {r.kind === 'other' && <TextField label="Description" name={`desc-${i}`} value={r.description ?? ''} onChange={(v) => upd(i, { description: v })} />}
            </div>
            <div className="row between"><CheckField label="Mandatory" checked={r.mandatory} onChange={(v) => upd(i, { mandatory: v })} />
              <Button tone="secondary" onClick={() => { setSaved(false); setRows(rows.filter((_, j) => j !== i)); }}>Remove</Button></div>
          </div>
        ))}
        {draft && <div className="row"><Button tone="secondary" onClick={() => { setSaved(false); setRows([...rows, { kind: 'license', credential_type: '', jurisdiction: '', description: null, mandatory: true }]); }}>Add a requirement</Button>
          <Button pending={save.pending} onClick={() => void save.run()}>Save requirements</Button></div>}
      </fieldset>
    </Card>
  );
}

/** Starts unfilled-shift recovery for one open shift of a published job. It needs recovery switched on in the settings. */
function StartRecovery({ orgId, shiftId }: { orgId: string; shiftId: string }) {
  const client = useClient();
  const [started, setStarted] = useState(false);
  const start = useAction(async () => { await client.post(`/organizations/${orgId}/shift-recovery/shifts/${shiftId}/start`); setStarted(true); });
  if (started) return <span className="small"><Link href={`/facility/${orgId}/recovery`}>Started: see progress</Link></span>;
  return (
    <>
      <ConfirmButton tone="primary" label="Keep trying to fill" message="Start automatic outreach for this shift? It will offer it to the next eligible people within the limits in your recovery settings." pending={start.pending} onConfirm={() => start.run()} />
      {start.error && <p className="small" style={{ color: 'var(--danger)' }}>{start.error.message} {start.error.status === 409 && <Link href={`/facility/${orgId}/recovery`}>Open settings</Link>}</p>}
    </>
  );
}

function Shifts({ orgId, d, reload }: { orgId: string; d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const { can } = useOrg();
  const { locations } = useLocations(orgId);
  const tz = locations.find((l) => l.id === d.job.location_id)?.timezone ?? 'UTC';
  const editable = ['draft', 'published', 'paused'].includes(d.job.status ?? '');
  const draft = d.job.status === 'draft';
  const [f, setF] = useState({ starts: '', ends: '', positions: '1', rate: '', notes: '' });
  const add = useAction(async () => {
    await client.post(`/organizations/${orgId}/jobs/${d.job.id}/shifts`, {
      startsAt: zonedTimeToIso(f.starts, tz), endsAt: zonedTimeToIso(f.ends, tz), positions: Number(f.positions) || 1,
      hourlyRateCents: f.rate ? Math.round(Number(f.rate) * 100) : undefined, notes: f.notes || undefined,
    });
    setF({ starts: '', ends: '', positions: '1', rate: '', notes: '' }); await reload();
  });
  const cancel = useAction(async (id: string) => { await client.patch(`/organizations/${orgId}/jobs/${d.job.id}/shifts/${id}`, { status: 'cancelled' }); await reload(); });
  const remove = useAction(async (id: string) => { await client.delete(`/organizations/${orgId}/jobs/${d.job.id}/shifts/${id}`); await reload(); });
  if (d.job.employment_type === 'permanent') return <Card title="Shifts"><p className="muted">Permanent positions do not have shifts.</p></Card>;
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Card title="Shifts">
      <p className="muted">All times are in the location’s time zone: <strong>{tz}</strong>.</p>
      <ErrorAlert error={cancel.error ?? remove.error} />
      <DataTable caption="Shifts" rows={d.shifts} rowKey={(s) => s.id} empty={<p className="muted">No shifts yet. Add at least one upcoming shift to publish.</p>}
        columns={[
          { header: 'Starts', cell: (s) => formatDateTime(s.starts_at, tz) }, { header: 'Ends', cell: (s) => formatDateTime(s.ends_at, tz) }, { header: 'Needed', cell: (s) => s.positions },
          { header: 'Rate', cell: (s) => (s.hourly_rate_cents ? `$${(s.hourly_rate_cents / 100).toFixed(2)}/hr` : '—') }, { header: 'Status', cell: (s) => <Badge tone={s.status === 'open' ? 'success' : 'neutral'}>{titleCase(s.status)}</Badge> },
          ...(d.job.status === 'published' && can('applications.manage') ? [{ header: 'Fill help', cell: (s: Shift) => (s.status === 'open' ? <StartRecovery orgId={orgId} shiftId={s.id} /> : '—') }] : []),
          { header: 'Actions', cell: (s) => s.status !== 'open' || !editable ? '—' : (
            <div className="row">
              {draft ? <ConfirmButton label="Delete" message="Delete this shift?" onConfirm={() => remove.run(s.id)} /> : <ConfirmButton label="Cancel shift" message="Cancel this shift? Applicants who selected it are not notified automatically." onConfirm={() => cancel.run(s.id)} />}
            </div>) },
        ]} />
      {editable && (
        <form onSubmit={(e) => { e.preventDefault(); void add.run(); }} noValidate>
          <h3>Add a shift</h3>
          <ErrorAlert error={add.error} />
          <div className="form-grid">
            <TextField label="Starts" name="startsAt" type="datetime-local" required value={f.starts} onChange={set('starts')} error={add.error} />
            <TextField label="Ends" name="endsAt" type="datetime-local" required value={f.ends} onChange={set('ends')} error={add.error} hint="At most 24 hours long." />
            <TextField label="People needed" name="positions" type="number" min={1} max={100} value={f.positions} onChange={set('positions')} error={add.error} />
            <TextField label="Hourly rate override ($, optional)" name="hourlyRateCents" type="number" min={0} step="0.01" value={f.rate} onChange={set('rate')} error={add.error} />
          </div>
          <TextArea label="Notes (optional)" name="notes" rows={2} value={f.notes} onChange={set('notes')} maxLength={500} error={add.error} />
          <Button type="submit" pending={add.pending} disabled={!f.starts || !f.ends}>Add shift</Button>
        </form>
      )}
    </Card>
  );
}

export default function JobManagePage() {
  const { org, can } = useOrg();
  const { jobId } = useParams<{ jobId: string }>();
  const state = useApi<Detail>(`/organizations/${org.id}/jobs/${jobId}`);
  return (
    <>
      <p><Link href={`/facility/${org.id}/jobs`}>← All jobs</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.job.title} subtitle={<JobStatusBadge status={d.job.status ?? 'draft'} />}
              actions={d.job.status !== 'draft' ? <><LinkButton href={`/facility/${org.id}/jobs/${d.job.id}/candidates`}>Applicants</LinkButton><LinkButton tone="secondary" href={`/facility/${org.id}/talent?jobId=${d.job.id}`}>Find professionals</LinkButton></> : undefined} />
            {can('jobs.manage') ? (
              <>
                <Lifecycle orgId={org.id} d={d} reload={state.reload} />
                <Card title="Details"><JobForm orgId={org.id} job={d.job} onSaved={() => void state.reload()} /></Card>
                <Requirements key={JSON.stringify(d.requirements)} orgId={org.id} d={d} reload={state.reload} />
                <Shifts orgId={org.id} d={d} reload={state.reload} />
              </>
            ) : <Alert tone="info">Your role can view this job but not change it.</Alert>}
            {can('jobs.read') && <AgencyAccess orgId={org.id} jobId={d.job.id} canManage={can('jobs.manage')} published={d.job.status === 'published'} />}
            <Card title="History"><Timeline items={d.history.map((h, i) => ({ key: String(i), at: h.created_at, title: h.from_status ? `${titleCase(h.from_status)} → ${titleCase(h.to_status)}` : `Created as ${titleCase(h.to_status)}`, detail: h.reason ?? undefined }))} /></Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
