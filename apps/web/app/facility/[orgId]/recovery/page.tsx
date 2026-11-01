'use client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CheckField, ConfirmButton, EmptyState, ErrorAlert, PageHeader, QueryBoundary, TextField, centsToDollars, formatDateTime, useAction, useApi, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Settings { enabled: boolean; maxOutreach: number; offerHours: number; escalateHours: number; minLeadHours: number; includeFloatPool: boolean }
interface SettingsResponse { available: boolean; settings: Settings; enabledBy: string | null; approverActive: boolean | null; participatesInExchange: boolean }
interface Escalation {
  openPositions: number; positions: number; hoursToStart: number; liveOutreach: number;
  outreach: { offers: number; floatRequests: number; declined: number; expired: number };
  candidates: { eligibleNotContacted: number; pendingVerification: number; unavailable: number; ineligible: number };
  reasons: string[]; steps: string[];
}
interface RecoveryShift {
  shift_id: string; status: string; started_by: string; last_run_at: string | null; escalated_at: string | null; escalation: Escalation | null;
  title: string; starts_at: string; ends_at: string; hourly_rate_cents: number | null; open_positions: number; waiting: number; automatic_outreach: number;
}

function SettingsCard({ orgId, data, reload }: { orgId: string; data: SettingsResponse; reload: () => Promise<void> }) {
  const { can, approved } = useOrg();
  const client = useClient();
  const [s, setS] = useState<Settings>(data.settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setS(data.settings), [data.settings]);
  const num = (k: keyof Settings) => (v: string) => { setSaved(false); setS({ ...s, [k]: Number(v) }); };
  const save = useAction(async () => { await client.put(`/organizations/${orgId}/shift-recovery/settings`, s); setSaved(true); await reload(); });
  const editable = can('org.update') && approved && data.available;
  return (
    <Card title="Settings">
      <Alert tone="info" title="What this does">
        When an offer for a shift expires or is declined and the shift is still short, BSM keeps going on your behalf: it offers the shift to the next best <strong>eligible</strong> people, within the limits below, and tells you if it still cannot be filled.
        It never skips a requirement, only uses the rate already set on the shift, and each automatic offer is attributed to the person who switched this on.
      </Alert>
      {!data.available && <Alert tone="warning" title="Not available yet">Automatic outreach opens once BSM has completed its legal review. Until then it cannot be switched on, and nothing is sent automatically. You can still send offers yourself.</Alert>}
      {data.settings.enabled && data.approverActive === false && <Alert tone="warning" title="Paused">The person who approved automatic offers ({data.enabledBy}) is no longer an active member. An owner or admin needs to turn this on again.</Alert>}
      {data.settings.enabled && data.approverActive && <p className="small muted">Switched on by {data.enabledBy}. Automatic offers are made on their behalf.</p>}
      <ErrorAlert error={save.error} />
      {saved && <Alert tone="success">Saved.</Alert>}
      <form onSubmit={(e) => { e.preventDefault(); setSaved(false); void save.run(); }} noValidate>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0 }}>
          <CheckField label="Keep trying to fill shifts automatically" name="enabled" checked={s.enabled && data.available} onChange={(v) => { setSaved(false); setS({ ...s, enabled: v }); }} hint="Off by default. Nothing is sent automatically until you turn this on." />
          <div className="form-grid">
            <TextField label="Most automatic offers per shift" name="maxOutreach" type="number" min={1} max={25} value={String(s.maxOutreach)} onChange={num('maxOutreach')} error={save.error} hint="A hard stop for each shift." />
            <TextField label="Each offer stays open for (hours)" name="offerHours" type="number" min={1} max={72} value={String(s.offerHours)} onChange={num('offerHours')} error={save.error} hint="Never longer than until the shift starts." />
            <TextField label="Tell me if still short within (hours of the start)" name="escalateHours" type="number" min={2} max={336} value={String(s.escalateHours)} onChange={num('escalateHours')} error={save.error} />
            <TextField label="No new automatic offers within (hours of the start)" name="minLeadHours" type="number" min={0} max={48} value={String(s.minLeadHours)} onChange={num('minLeadHours')} error={save.error} />
          </div>
          <CheckField label="Include professionals in my region’s float pool" name="includeFloatPool" checked={s.includeFloatPool} onChange={(v) => { setSaved(false); setS({ ...s, includeFloatPool: v }); }}
            hint={data.participatesInExchange ? 'They stay anonymous until they accept.' : 'Join your region’s exchange first for this to take effect.'} />
        </fieldset>
        {editable ? <Button type="submit" pending={save.pending}>Save settings</Button> : <p className="small muted">Only owners and admins of an approved organization can change these.</p>}
      </form>
    </Card>
  );
}

function ShiftCard({ orgId, s, reload }: { orgId: string; s: RecoveryShift; reload: () => Promise<void> }) {
  const { can } = useOrg();
  const client = useClient();
  const act = useAction(async (what: 'start' | 'stop') => { await client.post(`/organizations/${orgId}/shift-recovery/shifts/${s.shift_id}/${what}`); await reload(); });
  const needsAttention = s.status === 'active' && s.escalated_at && s.open_positions > 0;
  const e = s.escalation;
  return (
    <Card title={`${s.title} · ${formatDateTime(s.starts_at)}`} actions={needsAttention ? <Badge tone="danger">Needs attention</Badge> : <Badge tone={s.status === 'active' ? 'info' : 'neutral'}>{s.status === 'active' ? 'Working on it' : s.status === 'filled' ? 'Filled' : 'Stopped'}</Badge>}>
      <p>
        <strong>{s.open_positions}</strong> open · <strong>{s.waiting}</strong> waiting for an answer · <strong>{s.automatic_outreach}</strong> automatic offers so far
        {s.hourly_rate_cents != null ? <> · ${centsToDollars(s.hourly_rate_cents)}/hr</> : <> · <span style={{ color: 'var(--danger)' }}>no rate set</span></>}
      </p>
      {needsAttention && e && (
        <Alert tone="warning" title={`Still short ${e.hoursToStart < 48 ? `with ${Math.max(0, Math.round(e.hoursToStart))} hours to go` : ''}`.trim()}>
          {e.reasons.length > 0 && <p style={{ margin: '0 0 6px' }}>Why: {e.reasons.join('; ')}.</p>}
          <p className="small" style={{ margin: '0 0 6px' }}>
            Asked {e.outreach.offers + e.outreach.floatRequests} {e.outreach.offers + e.outreach.floatRequests === 1 ? 'person' : 'people'} · {e.outreach.declined} declined · {e.outreach.expired} did not answer.
            {e.candidates.pendingVerification > 0 && <> {e.candidates.pendingVerification} waiting on credential review.</>}
            {e.candidates.unavailable > 0 && <> {e.candidates.unavailable} unavailable.</>}
          </p>
          <strong className="small">Suggested next steps</strong>
          <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>{e.steps.map((step) => <li key={step}>{step}</li>)}</ul>
        </Alert>
      )}
      <ErrorAlert error={act.error} />
      {can('applications.manage') && s.status !== 'filled' && (s.status === 'active'
        ? <ConfirmButton label="Stop automatic outreach" message="Stop automatic outreach for this shift? Offers already sent stay open." pending={act.pending} onConfirm={() => act.run('stop')} />
        : <Button tone="secondary" pending={act.pending} onClick={() => void act.run('start')}>Start again</Button>)}
      {s.last_run_at && <p className="small muted">Last checked {formatDateTime(s.last_run_at)}.</p>}
    </Card>
  );
}

export default function RecoveryPage() {
  const { org, can } = useOrg();
  const client = useClient();
  const settings = useApi<SettingsResponse>(`/organizations/${org.id}/shift-recovery/settings`);
  const shifts = useApi<{ shifts: RecoveryShift[] }>(`/organizations/${org.id}/shift-recovery`);
  const [ran, setRan] = useState<string | null>(null);
  const run = useAction(async () => {
    const r = await client.post<{ summary: { offersSent: number; requestsSent: number; escalated: number } }>(`/organizations/${org.id}/shift-recovery/run`);
    setRan(`Checked. ${r.summary.offersSent + r.summary.requestsSent} new offer(s) sent, ${r.summary.escalated} shift(s) escalated.`);
    await shifts.reload();
  });
  const reloadAll = async () => { await Promise.all([settings.reload(), shifts.reload()]); };
  return (
    <>
      <PageHeader title="Unfilled shift recovery" subtitle="Don’t just see vacancies: have them worked on until they are filled or you are told why they can’t be."
        actions={can('applications.manage') ? <Button tone="secondary" pending={run.pending} onClick={() => void run.run()}>Check now</Button> : undefined} />
      <ErrorAlert error={run.error} />
      {ran && <Alert tone="success">{ran} It also runs automatically every few minutes.</Alert>}
      <QueryBoundary state={settings}>{(d) => <SettingsCard orgId={org.id} data={d} reload={reloadAll} />}</QueryBoundary>
      <h2>Shifts being worked on</h2>
      <QueryBoundary state={shifts}>
        {(d) => d.shifts.length === 0 ? <EmptyState title="Nothing in recovery">A shift appears here when an offer for it expires or is declined and it is still unfilled, or when you start recovery for it yourself from the shift’s page.</EmptyState> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>{d.shifts.map((s) => <li key={s.shift_id}><ShiftCard orgId={org.id} s={s} reload={reloadAll} /></li>)}</ul>
        )}
      </QueryBoundary>
    </>
  );
}
