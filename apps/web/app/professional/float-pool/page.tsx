'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CheckField, ConfirmButton, EmptyState, ErrorAlert, PageHeader, QueryBoundary, centsToDollars, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Region { id: string; name: string; states: string[]; joined: boolean }
interface Info { regions: Region[]; terms: { version: string; text: string } }
interface Req { id: string; status: string; hourly_rate_cents: number; message: string | null; created_at: string; expires_at: string; failure_reason: string | null; title: string; organization_name: string; city: string; state: string; starts_at: string; ends_at: string }

const TONE: Record<string, 'info' | 'success' | 'neutral' | 'warning'> = { pending: 'info', accepted: 'success', declined: 'neutral', withdrawn: 'neutral', expired: 'neutral', failed: 'warning' };

function RegionCard({ region, terms, reload }: { region: Region; terms: Info['terms']; reload: () => Promise<void> }) {
  const client = useClient();
  const [agree, setAgree] = useState(false);
  const [open, setOpen] = useState(false);
  const join = useAction(async () => { await client.post('/professionals/me/float-pool/join', { regionId: region.id, accept: true }); setOpen(false); setAgree(false); await reload(); });
  const leave = useAction(async () => { await client.post('/professionals/me/float-pool/leave', { regionId: region.id }); await reload(); });
  return (
    <Card title={region.name} actions={region.joined ? <Badge tone="success">You are in this pool</Badge> : undefined}>
      <p className="muted small">Covers {region.states.join(', ')}</p>
      <ErrorAlert error={join.error ?? leave.error} />
      {region.joined ? (
        <ConfirmButton label="Leave this pool" message={`Leave the ${region.name} pool? Requests you have not answered will be withdrawn.`} pending={leave.pending} onConfirm={() => leave.run()} />
      ) : !open ? <Button onClick={() => setOpen(true)}>Join this pool</Button> : (
        <form onSubmit={(e) => { e.preventDefault(); void join.run(); }} noValidate>
          <Alert tone="info" title="What joining means">
            {terms.text.split('\n\n').map((para) => <p key={para}>{para}</p>)}
          </Alert>
          <CheckField label="I have read this and agree to be shown to participating facilities in this region." name="agree" checked={agree} onChange={setAgree} />
          <div className="row"><Button type="submit" pending={join.pending} disabled={!agree}>Join {region.name}</Button><Button tone="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
        </form>
      )}
    </Card>
  );
}

function RequestCard({ r, reload }: { r: Req; reload: () => Promise<void> }) {
  const client = useClient();
  const answer = useAction(async (response: 'accepted' | 'declined') => { await client.post(`/professionals/me/float-pool/requests/${r.id}/respond`, { response }); await reload(); });
  return (
    <Card title={`${r.title} · ${r.organization_name}`} actions={<Badge tone={TONE[r.status] ?? 'neutral'}>{titleCase(r.status)}</Badge>}>
      <p>{formatDateTime(r.starts_at)} – {formatDateTime(r.ends_at)} · {r.city}, {r.state} · <strong>${centsToDollars(r.hourly_rate_cents)}/hr</strong></p>
      {r.message && <blockquote style={{ margin: '8px 0', paddingLeft: 12, borderLeft: '3px solid var(--border)' }}>{r.message}</blockquote>}
      {r.status === 'failed' && r.failure_reason && <Alert tone="warning">{r.failure_reason}</Alert>}
      {r.status === 'pending' && (
        <>
          <p className="small muted">Answer by {formatDateTime(r.expires_at)}. {r.organization_name} learns who you are only if you accept, and your credentials and schedule are checked again then.</p>
          <ErrorAlert error={answer.error} />
          <div className="row">
            <ConfirmButton tone="primary" label="Accept" message={`Accept this shift at ${r.organization_name}? Your name will be shared with them and the shift will be added to your schedule.`} pending={answer.pending} onConfirm={() => answer.run('accepted')} />
            <ConfirmButton label="Decline" message="Decline this request? The facility will not be told who you are." pending={answer.pending} onConfirm={() => answer.run('declined')} />
          </div>
        </>
      )}
    </Card>
  );
}

export default function FloatPoolPage() {
  const info = useApi<Info>('/professionals/me/float-pool');
  const reqs = useApi<{ requests: Req[] }>('/professionals/me/float-pool/requests');
  const reloadAll = async () => { await Promise.all([info.reload(), reqs.reload()]); };
  return (
    <>
      <PageHeader title="Regional float pool" subtitle="Be available to facilities across your region, on your terms, and stay anonymous until you say yes." />
      <Alert tone="info">Joining is optional and separate from being discoverable for jobs. Facilities see an anonymous card, never your name or pay history, and you can leave at any time.</Alert>
      <Card title="Requests for you">
        <QueryBoundary state={reqs}>
          {(d) => d.requests.length === 0 ? <EmptyState title="No requests">When a facility asks you to cover a shift, it appears here and in your notifications.</EmptyState> : (
            <ul style={{ listStyle: 'none', padding: 0 }}>{d.requests.map((r) => <li key={r.id}><RequestCard r={r} reload={reloadAll} /></li>)}</ul>
          )}
        </QueryBoundary>
      </Card>
      <h2>Regions</h2>
      <QueryBoundary state={info}>
        {(d) => d.regions.length === 0 ? <EmptyState title="No regions yet">BSM has not opened any regional pools yet.</EmptyState> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>{d.regions.map((r) => <li key={r.id}><RegionCard region={r} terms={d.terms} reload={reloadAll} /></li>)}</ul>
        )}
      </QueryBoundary>
    </>
  );
}
