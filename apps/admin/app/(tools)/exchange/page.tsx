'use client';
import Link from 'next/link';
import { useState } from 'react';
import { US_STATE_CODES, Alert, Badge, Button, Card, ConfirmButton, DataTable, ErrorAlert, PageHeader, QueryBoundary, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Region { id: string; name: string; states: string[]; active: boolean; pool_members: number; participating_facilities: number }
interface Participant { id: string; status: string; status_reason: string | null; accepted_at: string; organization_id: string; organization_name: string; region_name: string }

function Regions() {
  const client = useClient();
  const list = useApi<{ regions: Region[] }>('/admin/exchange/regions');
  const [name, setName] = useState('');
  const [states, setStates] = useState('');
  const parsed = states.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const invalid = parsed.filter((s) => !US_STATE_CODES.includes(s));
  const create = useAction(async () => { await client.post('/admin/exchange/regions', { name, states: parsed }); setName(''); setStates(''); await list.reload(); });
  const toggle = useAction(async (r: Region) => { await client.patch(`/admin/exchange/regions/${r.id}`, { active: !r.active }); await list.reload(); });
  return (
    <>
      <Card title="Regions">
        <p className="muted">A region is a named set of states. Professionals join a region’s pool; facilities with a location in it can agree to the exchange terms. Deactivating a region hides it from new joins but does not remove anyone.</p>
        <ErrorAlert error={toggle.error} />
        <QueryBoundary state={list}>
          {(d) => <DataTable caption="Exchange regions" rows={d.regions} rowKey={(r) => r.id} empty={<p className="muted">No regions yet.</p>} columns={[
            { header: 'Name', cell: (r) => r.name }, { header: 'States', cell: (r) => r.states.join(', ') },
            { header: 'Pool members', cell: (r) => r.pool_members }, { header: 'Facilities', cell: (r) => r.participating_facilities },
            { header: 'Status', cell: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
            { header: 'Actions', cell: (r) => <Button tone="secondary" pending={toggle.pending} onClick={() => void toggle.run(r)}>{r.active ? 'Deactivate' : 'Activate'}</Button> },
          ]} />}
        </QueryBoundary>
      </Card>
      <Card title="Add a region">
        <form onSubmit={(e) => { e.preventDefault(); void create.run(); }} noValidate>
          <ErrorAlert error={create.error} />
          <div className="form-grid">
            <TextField label="Name" name="name" required value={name} onChange={setName} error={create.error} />
            <TextField label="States (two-letter codes, separated by commas)" name="states" required value={states} onChange={setStates} error={create.error} hint="For example: GA, AL, TN" />
          </div>
          {invalid.length > 0 && <Alert tone="warning">Not US state codes: {invalid.join(', ')}</Alert>}
          <Button type="submit" pending={create.pending} disabled={name.trim().length < 3 || parsed.length === 0 || invalid.length > 0}>Create region</Button>
        </form>
      </Card>
    </>
  );
}

function Participants() {
  const client = useClient();
  const list = useApi<{ participants: Participant[] }>('/admin/exchange/participants');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const set = useAction(async (p: Participant, status: 'suspended' | 'active') => {
    await client.post(`/admin/exchange/participants/${p.id}/status`, { status, reason: reasons[p.id] ?? '' });
    setReasons({ ...reasons, [p.id]: '' }); await list.reload();
  });
  return (
    <Card title="Participating facilities">
      <p className="muted">Suspend a facility that breaks the exchange terms (for example by trying to identify or contact pool members). Suspension withdraws its waiting requests and closes the pool to it. The reason is shown to the facility.</p>
      <ErrorAlert error={set.error} />
      <QueryBoundary state={list}>
        {(d) => <DataTable caption="Exchange participants" rows={d.participants} rowKey={(p) => p.id} empty={<p className="muted">No facility has joined an exchange yet.</p>} columns={[
          { header: 'Facility', cell: (p) => <Link href={`/organizations/${p.organization_id}`}>{p.organization_name}</Link> }, { header: 'Region', cell: (p) => p.region_name },
          { header: 'Status', cell: (p) => <><Badge tone={p.status === 'active' ? 'success' : p.status === 'suspended' ? 'danger' : 'neutral'}>{titleCase(p.status)}</Badge>{p.status_reason && <span className="small muted"> {p.status_reason}</span>}</> },
          { header: 'Joined', cell: (p) => formatDateTime(p.accepted_at) },
          { header: 'Action', cell: (p) => p.status === 'withdrawn' ? <span className="muted small">—</span> : (
            <>
              <TextField label="Reason" name={`reason-${p.id}`} value={reasons[p.id] ?? ''} onChange={(v) => setReasons({ ...reasons, [p.id]: v })} maxLength={1000} />
              {p.status === 'active'
                ? <ConfirmButton label="Suspend" message={`Suspend ${p.organization_name} from the ${p.region_name} exchange?`} pending={set.pending} onConfirm={() => ((reasons[p.id] ?? '').trim().length >= 3 ? set.run(p, 'suspended') : Promise.resolve())} />
                : <Button pending={set.pending} disabled={(reasons[p.id] ?? '').trim().length < 3} onClick={() => void set.run(p, 'active')}>Reinstate</Button>}
            </>
          ) },
        ]} />}
      </QueryBoundary>
    </Card>
  );
}

export default function ExchangeAdminPage() {
  return (
    <>
      <PageHeader title="Regional exchange" subtitle="Regions for the shared float pool, and the facilities allowed to use it." />
      <Regions />
      <Participants />
    </>
  );
}
