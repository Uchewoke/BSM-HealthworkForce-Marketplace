'use client';
import { useState } from 'react';
import { Alert, AssignmentStatusBadge, Card, ConfirmButton, DataTable, EmptyState, ErrorAlert, Pagination, QueryBoundary, ShiftOfferStatusBadge, TextField, formatDateTime, useAction, useApi, useClient } from '@bsm/ui';

interface Offer { id: string; status: string; title: string; organization_name: string; city: string; state: string; starts_at: string; ends_at: string; hourly_rate_cents: number; message: string | null; expires_at: string }
interface Assignment { id: string; status: string; title: string; organization_name: string; city: string; state: string; starts_at: string; ends_at: string; hourly_rate_cents: number }

const money = (cents: number) => `$${(cents / 100).toFixed(2)}/hr`;
const when = (a: { starts_at: string; ends_at: string }) => `${formatDateTime(a.starts_at)} – ${formatDateTime(a.ends_at)}`;

function OfferActions({ o, reload }: { o: Offer; reload: () => Promise<void> }) {
  const client = useClient();
  const act = useAction(async (response: 'accepted' | 'declined') => { await client.post(`/professionals/me/shift-offers/${o.id}/respond`, { response }); await reload(); });
  if (o.status !== 'sent') return null;
  return (
    <>
      <div className="row">
        <ConfirmButton tone="primary" label="Accept" message="Accept this shift? Your credentials and schedule are checked again at this moment." pending={act.pending} onConfirm={() => act.run('accepted')} />
        <ConfirmButton label="Decline" message="Decline this shift offer?" pending={act.pending} onConfirm={() => act.run('declined')} />
      </div>
      {act.error && <ErrorAlert error={act.error} />}
    </>
  );
}

export function ShiftOffersSection({ onChanged }: { onChanged?: () => void }) {
  const [page, setPage] = useState(1);
  const list = useApi<{ offers: Offer[]; total: number; pageSize: number }>('/professionals/me/shift-offers', { page });
  const reload = async () => { await list.reload(); onChanged?.(); };
  return (
    <Card title="Shift offers">
      <Alert tone="info" title="What accepting means">
        Accepting records your booking for the shift on BSM. Pay and working terms are agreed directly with the facility; BSM does not process payments or create an employment relationship.
      </Alert>
      <QueryBoundary state={list}>
        {(d) => d.offers.length === 0 ? <EmptyState title="No shift offers yet" /> : (
          <>
            <DataTable caption="Your shift offers" rows={d.offers} rowKey={(o) => o.id}
              columns={[
                { header: 'Shift', cell: (o) => `${o.title} · ${o.organization_name}, ${o.city}, ${o.state}` },
                { header: 'When', cell: when }, { header: 'Rate', cell: (o) => money(o.hourly_rate_cents) },
                { header: 'Expires', cell: (o) => formatDateTime(o.expires_at) },
                { header: 'Status', cell: (o) => <ShiftOfferStatusBadge status={o.status} /> },
                { header: 'Respond', cell: (o) => <OfferActions o={o} reload={reload} /> },
              ]} />
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
                { header: 'When', cell: when }, { header: 'Rate', cell: (a) => money(a.hourly_rate_cents) },
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
