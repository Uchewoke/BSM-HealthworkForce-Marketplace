'use client';
import { useState } from 'react';
import {
  Alert, Badge, Button, Card, CheckField, ConfirmButton, DAYS, DataTable, EligibilityBadge, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, TextField,
  centsToDollars, dollarsToCents, formatDateTime, titleCase, useAction, useApi, useClient,
} from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface RegionRow { id: string; name: string; states: string[]; participation: string | null; has_location: boolean }
interface Regions { regions: RegionRow[]; terms: { version: string; text: string } }
interface Shift { id: string; title: string; starts_at: string; ends_at: string; hourly_rate_cents: number | null; open_positions: number; city: string; state: string }
interface Card_ {
  talentRef: string; profession: string; specialties: string[]; city: string | null; state: string | null; yearsExperience: number;
  credentials: { kind: string; credentialType: string; jurisdiction: string | null; statusLabel: string }[];
  availability: { dayOfWeek: number; startTime: string; endTime: string }[];
  match: null | { outcome: string; score: number | null; reasons: { code: string; message: string }[] };
}
interface Req { id: string; status: string; hourly_rate_cents: number; created_at: string; expires_at: string; failure_reason: string | null; application_id: string | null; title: string; starts_at: string; profession: string }
const TONE: Record<string, 'info' | 'success' | 'neutral' | 'warning'> = { pending: 'info', accepted: 'success', declined: 'neutral', withdrawn: 'neutral', expired: 'neutral', failed: 'warning' };

const when = (s: Shift) => `${formatDateTime(s.starts_at)} – ${formatDateTime(s.ends_at)}`;
const availabilityText = (a: Card_['availability']) => {
  const byDay = new Map<number, string[]>();
  for (const w of a) byDay.set(w.dayOfWeek, [...(byDay.get(w.dayOfWeek) ?? []), `${w.startTime}–${w.endTime}`]);
  return [...byDay.entries()].map(([d, t]) => `${DAYS[d]!.slice(0, 3)} ${t.join(', ')}`).join(' · ') || 'No times given';
};

function Participation({ orgId, regions, terms, canJoin, reload }: { orgId: string; regions: RegionRow[]; terms: Regions['terms']; canJoin: boolean; reload: () => Promise<void> }) {
  const client = useClient();
  const [agree, setAgree] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const join = useAction(async (regionId: string) => { await client.post(`/organizations/${orgId}/exchange/participation`, { regionId, acceptTerms: true }); setAgree(null); setAccepted(false); await reload(); });
  const leave = useAction(async (regionId: string) => { await client.delete(`/organizations/${orgId}/exchange/participation/${regionId}`); await reload(); });
  return (
    <Card title="Regions">
      <ErrorAlert error={join.error ?? leave.error} />
      {regions.length === 0 ? <p className="muted">BSM has not opened any regions yet.</p> : (
        <DataTable caption="Regional exchange" rows={regions} rowKey={(r) => r.id} columns={[
          { header: 'Region', cell: (r) => <>{r.name} <span className="muted small">({r.states.join(', ')})</span></> },
          { header: 'Your organization', cell: (r) => (r.participation === 'active' ? <Badge tone="success">Participating</Badge> : r.participation === 'suspended' ? <Badge tone="danger">Suspended</Badge> : r.has_location ? <span className="muted">Not joined</span> : <span className="muted small">No location in this region</span>) },
          { header: 'Actions', cell: (r) => !canJoin ? <span className="muted small">Owners and admins</span> : r.participation === 'active'
            ? <ConfirmButton label="Leave" message={`Leave the ${r.name} exchange? Requests still waiting will be withdrawn.`} pending={leave.pending} onConfirm={() => leave.run(r.id)} />
            : r.has_location && r.participation !== 'suspended' ? <Button tone="secondary" onClick={() => setAgree(r.id)}>Join…</Button> : <span className="muted small">—</span> },
        ]} />
      )}
      {agree && (
        <form onSubmit={(e) => { e.preventDefault(); void join.run(agree); }} noValidate>
          <Alert tone="info" title="Exchange terms">{terms.text.split('\n\n').map((p) => <p key={p}>{p}</p>)}</Alert>
          <CheckField label="Our organization agrees to these terms." name="terms" checked={accepted} onChange={setAccepted} />
          <div className="row"><Button type="submit" pending={join.pending} disabled={!accepted}>Join the exchange</Button><Button tone="secondary" onClick={() => setAgree(null)}>Cancel</Button></div>
        </form>
      )}
    </Card>
  );
}

function PoolCard({ orgId, card, shift, onSent }: { orgId: string; card: Card_; shift: Shift | null; onSent: () => Promise<void> }) {
  const client = useClient();
  const { can } = useOrg();
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState(shift?.hourly_rate_cents ? centsToDollars(shift.hourly_rate_cents) : '');
  const [message, setMessage] = useState('');
  const send = useAction(async () => {
    await client.post(`/organizations/${orgId}/exchange/requests`, { talentRef: card.talentRef, shiftId: shift!.id, hourlyRateCents: dollarsToCents(rate), message: message.trim() || undefined });
    setOpen(false); await onSent();
  });
  return (
    <Card title={`${card.profession}${card.specialties.length ? ` · ${card.specialties.join(', ')}` : ''}`} actions={card.match ? <EligibilityBadge outcome={card.match.outcome} /> : undefined}>
      <p className="muted">{[card.city, card.state].filter(Boolean).join(', ') || 'Location not given'} · {card.yearsExperience} years of experience</p>
      <p className="small"><strong>Credentials:</strong> {card.credentials.length ? card.credentials.map((c) => `${c.credentialType}${c.jurisdiction ? ` (${c.jurisdiction})` : ''}: ${c.statusLabel}`).join('; ') : 'None on file'}</p>
      <p className="small"><strong>Usually available:</strong> {availabilityText(card.availability)}</p>
      {card.match && card.match.outcome !== 'eligible' && <ul className="small">{card.match.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>}
      {shift && card.match?.outcome === 'eligible' && can('applications.manage') && (open ? (
        <form onSubmit={(e) => { e.preventDefault(); void send.run(); }} noValidate>
          <ErrorAlert error={send.error} />
          <div className="form-grid">
            <TextField label="Hourly rate ($)" name="rate" type="number" min={0} step="0.01" required value={rate} onChange={setRate} error={send.error} />
            <TextField label="Message (optional)" name="message" value={message} onChange={setMessage} maxLength={500} />
          </div>
          <p className="small muted">They will not learn who you are beyond this facility’s name, and you will not learn who they are unless they accept.</p>
          <div className="row"><Button type="submit" pending={send.pending} disabled={!rate}>Send request</Button><Button tone="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
        </form>
      ) : <Button onClick={() => setOpen(true)}>Request for this shift</Button>)}
    </Card>
  );
}

function Pool({ orgId, regionId }: { orgId: string; regionId: string }) {
  const [shiftId, setShiftId] = useState('');
  const [show, setShow] = useState('eligible');
  const [page, setPage] = useState(1);
  const shifts = useApi<{ shifts: Shift[] }>(`/organizations/${orgId}/exchange/shifts`, { regionId });
  const pool = useApi<{ pool: Card_[]; total: number; pageSize: number }>(`/organizations/${orgId}/exchange/pool`, { regionId, shiftId: shiftId || undefined, show: shiftId ? show : undefined, page });
  const requests = useApi<{ requests: Req[] }>(`/organizations/${orgId}/exchange/requests`);
  const client = useClient();
  const withdraw = useAction(async (id: string) => { await client.delete(`/organizations/${orgId}/exchange/requests/${id}`); await requests.reload(); });
  const chosen = shifts.data?.shifts.find((s) => s.id === shiftId) ?? null;
  const after = async () => { await Promise.all([pool.reload(), requests.reload()]); };
  return (
    <>
      <Card title="Find someone for a shift">
        <p className="muted">Pool members are anonymous. Choose one of your open shifts to see only the people who can actually work it, with their credentials and schedule checked against the job.</p>
        <QueryBoundary state={shifts}>
          {(d) => d.shifts.length === 0 ? <Alert tone="info">You have no open shifts with unfilled positions in this region. Publish a job with upcoming shifts first.</Alert> : (
            <div className="form-grid">
              <SelectField label="Shift" name="shift" value={shiftId} onChange={(v) => { setShiftId(v); setPage(1); }} placeholder="Show the whole pool" options={d.shifts.map((s) => ({ value: s.id, label: `${s.title} · ${when(s)} (${s.open_positions} open)` }))} />
              {shiftId && <SelectField label="Show" name="show" value={show} onChange={(v) => { setShow(v); setPage(1); }} options={[{ value: 'eligible', label: 'Only people who can work it' }, { value: 'all', label: 'Everyone, with reasons' }]} />}
            </div>
          )}
        </QueryBoundary>
      </Card>
      <QueryBoundary state={pool}>
        {(d) => d.pool.length === 0 ? <EmptyState title={shiftId ? 'No one available for that shift' : 'The pool is empty'}>{shiftId ? 'Try showing everyone to see why people do not match, or check back later.' : 'No professionals have joined this region’s pool yet.'}</EmptyState> : (
          <>
            <p className="muted" aria-live="polite">{d.total} {d.total === 1 ? 'person' : 'people'}</p>
            <ul style={{ listStyle: 'none', padding: 0 }}>{d.pool.map((c) => <li key={c.talentRef}><PoolCard orgId={orgId} card={c} shift={chosen} onSent={after} /></li>)}</ul>
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
      <Card title="Your requests">
        <ErrorAlert error={withdraw.error} />
        <QueryBoundary state={requests}>
          {(d) => <DataTable caption="Float requests" rows={d.requests} rowKey={(r) => r.id} empty={<p className="muted">You have not sent any requests.</p>} columns={[
            { header: 'Shift', cell: (r) => `${r.title} · ${formatDateTime(r.starts_at)}` }, { header: 'Profession', cell: (r) => r.profession }, { header: 'Rate', cell: (r) => `$${centsToDollars(r.hourly_rate_cents)}/hr` },
            { header: 'Status', cell: (r) => <Badge tone={TONE[r.status] ?? 'neutral'}>{titleCase(r.status)}</Badge> },
            { header: 'Details', cell: (r) => r.application_id ? <a href={`/facility/${orgId}/applications/${r.application_id}`}>View booking</a> : r.failure_reason ?? (r.status === 'pending' ? `Expires ${formatDateTime(r.expires_at)}` : '—') },
            { header: 'Actions', cell: (r) => r.status === 'pending' ? <ConfirmButton label="Withdraw" message="Withdraw this request?" pending={withdraw.pending} onConfirm={() => withdraw.run(r.id)} /> : <span className="muted small">—</span> },
          ]} />}
        </QueryBoundary>
      </Card>
    </>
  );
}

export default function ExchangePage() {
  const { org, can, approved } = useOrg();
  const regions = useApi<Regions>(`/organizations/${org.id}/exchange/regions`);
  const [regionId, setRegionId] = useState('');
  return (
    <>
      <PageHeader title="Regional exchange" subtitle="Fill open shifts from a shared pool of professionals who chose to be available across your region." />
      {!approved && <Alert tone="info">Your organization must be approved before it can use the exchange.</Alert>}
      <QueryBoundary state={regions}>
        {(d) => {
          const active = d.regions.filter((r) => r.participation === 'active');
          const current = regionId && active.some((r) => r.id === regionId) ? regionId : active[0]?.id ?? '';
          return (
            <>
              <Participation orgId={org.id} regions={d.regions} terms={d.terms} canJoin={can('org.update') && approved} reload={regions.reload} />
              {approved && current && (
                <>
                  {active.length > 1 && <SelectField label="Region" name="region" value={current} onChange={setRegionId} options={active.map((r) => ({ value: r.id, label: r.name }))} />}
                  <Pool key={current} orgId={org.id} regionId={current} />
                </>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
