'use client';
import { useState } from 'react';
import { Alert, AssignmentStatusBadge, Button, Card, ConfirmButton, DataTable, EligibilityPanel, EmptyState, ErrorAlert, Pagination, QueryBoundary, ShiftOfferStatusBadge, TextField, formatDateTime, useAction, useApi, useClient } from '@bsm/ui';

interface Offer { id: string; status: string; starts_at: string; ends_at: string; hourly_rate_cents: number; expires_at: string; professional_name: string }
interface Assignment { id: string; status: string; title: string; city: string; state: string; starts_at: string; ends_at: string; hourly_rate_cents: number; professional_name: string }

const money = (cents: number) => `$${(cents / 100).toFixed(2)}/hr`;
const when = (a: { starts_at: string; ends_at: string }) => `${formatDateTime(a.starts_at)} – ${formatDateTime(a.ends_at)}`;

function WithdrawOffer({ orgId, o, reload }: { orgId: string; o: Offer; reload: () => Promise<void> }) {
  const client = useClient();
  const act = useAction(async () => { await client.post(`/organizations/${orgId}/shift-offers/${o.id}/withdraw`, {}); await reload(); });
  if (o.status !== 'sent') return null;
  return (
    <>
      <ConfirmButton label="Withdraw" message="Withdraw this offer? The professional will be notified." pending={act.pending} onConfirm={() => act.run()} />
      {act.error && <ErrorAlert error={act.error} />}
    </>
  );
}

/** Offer a shift the applicant selected. Eligibility is re-checked on the server; the button never decides it. */
export function ApplicationShiftOffers({ orgId, applicationId, shifts, canManage }: {
  orgId: string; applicationId: string; shifts: { id: string; starts_at: string; ends_at: string }[]; canManage: boolean;
}) {
  const client = useClient();
  const list = useApi<{ offers: Offer[]; total: number; pageSize: number }>(`/organizations/${orgId}/shift-offers`, { applicationId, pageSize: 50 });
  const [rate, setRate] = useState('');
  const [message, setMessage] = useState('');
  const offer = useAction(async (shiftId: string) => {
    const dollars = rate.trim() === '' ? undefined : Math.round(Number(rate) * 100);
    await client.post(`/organizations/${orgId}/applications/${applicationId}/shift-offers`, { shiftId, hourlyRateCents: dollars, message: message.trim() || undefined });
    setMessage('');
    await list.reload();
  });
  const blocked = offer.error?.details?.reasons;
  if (shifts.length === 0) return null;
  return (
    <Card title="Shift offers">
      <p className="small muted">Offers record the booking on BSM only. Pay and working terms are agreed directly with the professional; no payments are processed here.</p>
      {blocked && <Alert tone="warning" title="Blocked">{offer.error?.message}<EligibilityPanel eligibility={{ outcome: offer.error!.details.outcome, reasons: blocked }} heading="Why" /></Alert>}
      {offer.error && !blocked && <ErrorAlert error={offer.error} />}
      {canManage && (
        <div className="stack">
          <TextField label="Hourly rate in dollars (blank uses the shift’s rate)" name="rate" value={rate} onChange={setRate} inputMode="decimal" />
          <TextField label="Message to the professional (optional)" name="message" value={message} onChange={setMessage} maxLength={2000} />
          <ul>
            {shifts.map((s) => (
              <li key={s.id} className="row">
                <span>{formatDateTime(s.starts_at)} – {formatDateTime(s.ends_at)}</span>
                <ConfirmButton tone="primary" label="Offer this shift" message="Offer this shift? Eligibility is checked again at this moment." pending={offer.pending} onConfirm={() => offer.run(s.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <QueryBoundary state={list}>
        {(d) => d.offers.length === 0 ? <p className="muted">No shift offers sent yet.</p> : (
          <DataTable caption="Shift offers for this application" rows={d.offers} rowKey={(o) => o.id}
            columns={[
              { header: 'Shift', cell: when }, { header: 'Rate', cell: (o) => money(o.hourly_rate_cents) },
              { header: 'Expires', cell: (o) => formatDateTime(o.expires_at) }, { header: 'Status', cell: (o) => <ShiftOfferStatusBadge status={o.status} /> },
              ...(canManage ? [{ header: 'Actions', cell: (o: Offer) => <WithdrawOffer orgId={orgId} o={o} reload={list.reload} /> }] : []),
            ]} />
        )}
      </QueryBoundary>
    </Card>
  );
}

function AssignmentActions({ orgId, a, reload }: { orgId: string; a: Assignment; reload: () => Promise<void> }) {
  const client = useClient();
  const [reason, setReason] = useState('');
  const act = useAction(async (to: string) => { await client.post(`/organizations/${orgId}/assignments/${a.id}/status`, { to, reason: reason.trim() || undefined }); setReason(''); await reload(); });
  if (a.status !== 'confirmed') return null;
  const started = new Date(a.starts_at) <= new Date();
  return (
    <div className="stack">
      {started ? (
        <div className="row">
          <ConfirmButton tone="primary" label="Mark completed" message="Record that this shift was worked?" pending={act.pending} onConfirm={() => act.run('completed')} />
          <ConfirmButton label="Mark no-show" message="Record a no-show for this professional?" pending={act.pending} onConfirm={() => act.run('no_show')} />
        </div>
      ) : (
        <>
          <TextField label="Reason for cancelling" name="reason" value={reason} onChange={setReason} maxLength={2000} hint="The professional will see this." />
          {reason.trim().length < 3
            ? <Button tone="secondary" disabled>Cancel assignment</Button>
            : <ConfirmButton label="Cancel assignment" message="Cancel this assignment? The professional will be notified." pending={act.pending} onConfirm={() => act.run('cancelled_by_facility')} />}
        </>
      )}
      {act.error && <ErrorAlert error={act.error} />}
    </div>
  );
}

export function OrgAssignmentsSection({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [page, setPage] = useState(1);
  const list = useApi<{ assignments: Assignment[]; total: number; pageSize: number }>(`/organizations/${orgId}/assignments`, { page, pageSize: 20 });
  return (
    <Card title="Shift assignments">
      <QueryBoundary state={list}>
        {(d) => d.assignments.length === 0 ? <EmptyState title="No shift assignments yet" /> : (
          <>
            <DataTable caption="Shift assignments" rows={d.assignments} rowKey={(a) => a.id}
              columns={[
                { header: 'Professional', cell: (a) => a.professional_name }, { header: 'Shift', cell: (a) => `${a.title} · ${a.city}, ${a.state}` },
                { header: 'When', cell: when }, { header: 'Rate', cell: (a) => money(a.hourly_rate_cents) },
                { header: 'Status', cell: (a) => <AssignmentStatusBadge status={a.status} /> },
                ...(canManage ? [{ header: 'Actions', cell: (a: Assignment) => <AssignmentActions orgId={orgId} a={a} reload={list.reload} /> }] : []),
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}
