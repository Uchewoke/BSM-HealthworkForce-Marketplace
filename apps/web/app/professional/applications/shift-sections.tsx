'use client';
import { useEffect, useState } from 'react';
import { Alert, AssignmentStatusBadge, Badge, Button, Card, ConfirmButton, DataTable, EmptyState, ErrorAlert, Pagination, QueryBoundary, ShiftOfferStatusBadge, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Requirement { kind: string; credential_type: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }
interface Offer {
  id: string; status: string; title: string; organization_name: string; city: string; state: string; location_name: string; address_line1: string; timezone: string;
  starts_at: string; ends_at: string; hourly_rate_cents: number; message: string | null; shift_notes: string | null; expires_at: string;
  requirements: Requirement[]; eligibility: { outcome: string; reasons: { code: string; message: string }[] } | null;
  assignment_id: string | null; assignment_status: string | null; assignment_created_at: string | null; assignment_undone_at: string | null;
}
interface Assignment { id: string; status: string; title: string; organization_name: string; city: string; state: string; starts_at: string; ends_at: string; hourly_rate_cents: number; timezone: string }
interface Accepted { assignmentId: string; undoUntil: string; nextSteps: string[] }

const money = (cents: number) => `$${(cents / 100).toFixed(2)}/hr`;
/** A shift is worked where the facility is, so show its times there, with the zone named (not in the viewer's own zone). */
const shiftWhen = (a: { starts_at: string; ends_at: string; timezone: string }) => {
  const day = (v: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: a.timezone }).format(new Date(v));
  const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: a.timezone }).format(new Date(a.ends_at));
  return day(a.starts_at) === day(a.ends_at) ? `${formatDateTime(a.starts_at, a.timezone)} – ${clock}` : `${formatDateTime(a.starts_at, a.timezone)} – ${formatDateTime(a.ends_at, a.timezone)}`;
};
const requirementText = (r: Requirement) => (r.kind === 'other' ? r.description : `${titleCase(r.kind)}: ${r.credential_type}${r.jurisdiction ? ` (${r.jurisdiction})` : ''}`);

/** Seconds left until `iso`, ticking once a second while the window is open. */
function useCountdown(iso: string | null): number {
  const [left, setLeft] = useState(() => (iso ? Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000)) : 0));
  useEffect(() => {
    if (!iso) { setLeft(0); return; }
    const tick = () => setLeft(Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [iso]);
  return left;
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Shown right after accepting, and for a few minutes after: what happens next, and a way to take it back. */
function Booked({ assignmentId, undoUntil, nextSteps, reload }: { assignmentId: string; undoUntil: string; nextSteps?: string[]; reload: () => Promise<void> }) {
  const client = useClient();
  const left = useCountdown(undoUntil);
  const [reason, setReason] = useState('');
  const undo = useAction(async () => { await client.post(`/professionals/me/assignments/${assignmentId}/undo`, reason.trim() ? { reason: reason.trim() } : {}); await reload(); });
  const needsReason = !!undo.error?.fieldErrors?.reason;
  return (
    <Alert tone="success" title="Booked">
      {nextSteps && nextSteps.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 20 }}>{nextSteps.map((s) => <li key={s}>{s}</li>)}</ul>}
      {needsReason && <><p className="small">{undo.error?.message}</p><TextField label="Why are you undoing this booking?" name="reason" value={reason} onChange={setReason} maxLength={1000} /></>}
      {!needsReason && <ErrorAlert error={undo.error} />}
      {left > 0 && <Button tone="secondary" className="large" pending={undo.pending} disabled={needsReason && reason.trim().length < 3} onClick={() => void undo.run()}>Undo ({clock(left)} left)</Button>}
    </Alert>
  );
}

function OfferCard({ o, reload }: { o: Offer; reload: () => Promise<void> }) {
  const client = useClient();
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const act = useAction(async (response: 'accepted' | 'declined') => {
    const r = await client.post<{ assignmentId?: string; undoUntil?: string; nextSteps?: string[] }>(`/professionals/me/shift-offers/${o.id}/respond`, { response });
    if (response === 'accepted' && r.assignmentId && r.undoUntil) setAccepted({ assignmentId: r.assignmentId, undoUntil: r.undoUntil, nextSteps: r.nextSteps ?? [] });
    await reload();
  });
  const open = o.status === 'sent';
  const cancelled = o.status === 'accepted' && !!o.assignment_status && o.assignment_status.startsWith('cancelled');
  const eligible = o.eligibility?.outcome === 'eligible';
  // An accepted offer keeps its undo option until the window closes, even after the page is reloaded.
  const recentUndo = o.status === 'accepted' && o.assignment_status === 'confirmed' && o.assignment_id && o.assignment_created_at ? new Date(new Date(o.assignment_created_at).getTime() + 5 * 60_000).toISOString() : null;
  const mandatory = o.requirements.filter((r) => r.mandatory);
  const preferred = o.requirements.filter((r) => !r.mandatory);
  return (
    <Card title={o.title} actions={cancelled ? <Badge tone="neutral">Booking cancelled</Badge> : <ShiftOfferStatusBadge status={o.status} />}>
      <p style={{ margin: '0 0 4px' }}><strong>{o.organization_name}</strong></p>
      <p className="muted" style={{ margin: '0 0 8px' }}>{o.location_name} · {o.address_line1}, {o.city}, {o.state}</p>
      <p style={{ fontSize: '1.1rem', margin: '0 0 4px' }}>{shiftWhen(o)}</p>
      <p style={{ fontSize: '1.25rem', margin: '0 0 8px' }}><strong>{money(o.hourly_rate_cents)}</strong></p>
      {(o.message || o.shift_notes) && (
        <div style={{ margin: '8px 0' }}>
          <strong className="small">Conditions and notes</strong>
          {o.message && <p style={{ margin: '2px 0' }}>{o.message}</p>}
          {o.shift_notes && <p style={{ margin: '2px 0' }}>{o.shift_notes}</p>}
        </div>
      )}
      <div style={{ margin: '8px 0' }}>
        <strong className="small">Required to work this shift</strong>
        {mandatory.length === 0 ? <p className="muted small" style={{ margin: '2px 0' }}>No credential requirements listed.</p> : <ul style={{ margin: '2px 0', paddingLeft: 20 }}>{mandatory.map((r, i) => <li key={i}>{requirementText(r)}</li>)}</ul>}
        {preferred.length > 0 && <p className="muted small" style={{ margin: '2px 0' }}>Preferred: {preferred.map(requirementText).join('; ')}</p>}
      </div>
      {open && o.eligibility && (eligible
        ? <Alert tone="success">You meet the requirements for this shift right now.</Alert>
        : <Alert tone="warning" title="You can’t accept this one yet"><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{o.eligibility.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul></Alert>)}
      {open && <p className="small muted">Offer open until {formatDateTime(o.expires_at)}. Accepting books the shift; pay and working terms are between you and the facility.</p>}
      <ErrorAlert error={act.error} />
      {open && (
        <div className="actions-stack">
          <Button className="large" pending={act.pending} disabled={!eligible} onClick={() => void act.run('accepted')}>Accept shift</Button>
          <ConfirmButton label="Decline" message="Decline this shift offer?" pending={act.pending} onConfirm={() => act.run('declined')} />
        </div>
      )}
      {cancelled
        ? <Alert tone="info" title={o.assignment_undone_at ? 'Taken back' : 'Booking cancelled'}>{o.assignment_undone_at ? 'You undid this booking. The shift is open again for the facility to fill, and nothing is held against you.' : 'This booking was cancelled, so you are no longer scheduled for this shift.'}</Alert>
        : accepted ? <Booked {...accepted} reload={reload} />
        : recentUndo && o.assignment_id && <Booked assignmentId={o.assignment_id} undoUntil={recentUndo} reload={reload} />}
    </Card>
  );
}

export function ShiftOffersSection({ onChanged }: { onChanged?: () => void }) {
  const [page, setPage] = useState(1);
  const list = useApi<{ offers: Offer[]; total: number; pageSize: number }>('/professionals/me/shift-offers', { page });
  const reload = async () => { await list.reload(); onChanged?.(); };
  return (
    <Card title="Shift offers">
      <Alert tone="info" title="What accepting means">
        Accepting records your booking for the shift on BSM, and you can undo it for a few minutes. Pay and working terms are agreed directly with the facility; BSM does not process payments or create an employment relationship.
      </Alert>
      <QueryBoundary state={list}>
        {(d) => d.offers.length === 0 ? <EmptyState title="No shift offers yet" /> : (
          <>
            <ul style={{ listStyle: 'none', padding: 0 }}>{d.offers.map((o) => <li key={o.id}><OfferCard o={o} reload={reload} /></li>)}</ul>
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

function CancelAssignment({ a, reload }: { a: Assignment; reload: () => Promise<void> }) {
  const client = useClient();
  const [reason, setReason] = useState('');
  const act = useAction(async () => { await client.post(`/professionals/me/assignments/${a.id}/cancel`, { reason }); setReason(''); await reload(); });
  if (a.status !== 'confirmed' || new Date(a.starts_at) <= new Date()) return null;
  return (
    <>
      <TextField label="Reason for cancelling" name="reason" value={reason} onChange={setReason} />
      <ConfirmButton label="Cancel assignment" message="Cancel this assignment? The facility will be notified." pending={act.pending} onConfirm={() => act.run()} />
      {act.error && <ErrorAlert error={act.error} />}
    </>
  );
}

export function AssignmentsSection() {
  const [page, setPage] = useState(1);
  const list = useApi<{ assignments: Assignment[]; total: number; pageSize: number }>('/professionals/me/assignments', { page });
  return (
    <Card title="My assignments">
      <QueryBoundary state={list}>
        {(d) => d.assignments.length === 0 ? <EmptyState title="No assignments yet" /> : (
          <>
            <DataTable caption="Your assignments" rows={d.assignments} rowKey={(a) => a.id}
              columns={[
                { header: 'Shift', cell: (a) => `${a.title} · ${a.organization_name}, ${a.city}, ${a.state}` },
                { header: 'When', cell: shiftWhen }, { header: 'Rate', cell: (a) => money(a.hourly_rate_cents) },
                { header: 'Status', cell: (a) => <AssignmentStatusBadge status={a.status} /> },
                { header: 'Actions', cell: (a) => <CancelAssignment a={a} reload={list.reload} /> },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}
