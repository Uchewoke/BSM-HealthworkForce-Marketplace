'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmButton, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextField, US_STATE_CODES, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Fac { id: string; name: string; facility_type: string; active: boolean }
interface Loc { id: string; name: string; address_line1: string; city: string; state: string; postal_code: string; timezone: string; active: boolean }
interface Dept { id: string; name: string; active: boolean }

const TYPES = ['hospital', 'clinic', 'long_term_care', 'rehabilitation', 'home_health', 'other'].map((v) => ({ value: v, label: titleCase(v) }));
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'].map((z) => ({ value: z, label: z.replace('America/', '').replace('Pacific/', '').replace('_', ' ') }));

function Departments({ base, canEdit }: { base: string; canEdit: boolean }) {
  const client = useClient();
  const list = useApi<{ departments: Dept[] }>(`${base}/departments`);
  const [name, setName] = useState('');
  const add = useAction(async () => { await client.post(`${base}/departments`, { name }); setName(''); await list.reload(); });
  const toggle = useAction(async (d: Dept) => { await client.patch(`${base}/departments/${d.id}`, { active: !d.active }); await list.reload(); });
  return (
    <div style={{ marginLeft: 16 }}>
      <strong>Departments</strong>
      <QueryBoundary state={list}>
        {(d) => d.departments.length === 0 ? <p className="muted small">No departments yet.</p> : (
          <ul>{d.departments.map((x) => (
            <li key={x.id}>{x.name} {!x.active && <Badge>Inactive</Badge>} {canEdit && <Button tone="secondary" onClick={() => void toggle.run(x)}>{x.active ? 'Deactivate' : 'Reactivate'}</Button>}</li>
          ))}</ul>
        )}
      </QueryBoundary>
      <ErrorAlert error={add.error ?? toggle.error} />
      {canEdit && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <TextField label="New department" name="name" value={name} onChange={setName} error={add.error} />
          <Button type="submit" pending={add.pending} disabled={name.trim().length < 2}>Add department</Button>
        </form>
      )}
    </div>
  );
}

function AddLocation({ base, onAdded }: { base: string; onAdded: () => void }) {
  const client = useClient();
  const [f, setF] = useState({ name: '', addressLine1: '', city: '', state: '', postalCode: '', timezone: 'America/New_York', phone: '' });
  const add = useAction(async () => { await client.post(`${base}/locations`, { ...f, phone: f.phone || undefined }); setF({ ...f, name: '', addressLine1: '', city: '', postalCode: '', phone: '' }); onAdded(); });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void add.run(); }} noValidate>
      <h4>Add a location</h4>
      <ErrorAlert error={add.error} />
      <div className="form-grid">
        <TextField label="Location name" name="name" required value={f.name} onChange={set('name')} error={add.error} />
        <TextField label="Street address" name="addressLine1" required value={f.addressLine1} onChange={set('addressLine1')} error={add.error} />
        <TextField label="City" name="city" required value={f.city} onChange={set('city')} error={add.error} />
        <SelectField label="State" name="state" required value={f.state} onChange={set('state')} placeholder="—" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} error={add.error} />
        <TextField label="ZIP code" name="postalCode" required value={f.postalCode} onChange={set('postalCode')} error={add.error} hint="12345 or 12345-6789" />
        <SelectField label="Time zone" name="timezone" required value={f.timezone} onChange={set('timezone')} options={ZONES} error={add.error} hint="Shift times are shown in this zone." />
        <TextField label="Phone (optional)" name="phone" type="tel" value={f.phone} onChange={set('phone')} error={add.error} />
      </div>
      <Button type="submit" pending={add.pending}>Add location</Button>
    </form>
  );
}

function FacilityCard({ orgId, fac, canEdit, reload }: { orgId: string; fac: Fac; canEdit: boolean; reload: () => Promise<void> }) {
  const client = useClient();
  const base = `/organizations/${orgId}/facilities/${fac.id}`;
  const locs = useApi<{ locations: Loc[] }>(`${base}/locations`);
  const toggleFac = useAction(async () => { await client.patch(base, { active: !fac.active }); await reload(); });
  const toggleLoc = useAction(async (l: Loc) => { await client.patch(`${base}/locations/${l.id}`, { active: !l.active }); await locs.reload(); });
  return (
    <Card title={fac.name} actions={<><Badge>{titleCase(fac.facility_type)}</Badge>{!fac.active && <Badge tone="warning">Inactive</Badge>}{canEdit && (fac.active
      ? <ConfirmButton label="Deactivate" message="Deactivate this facility? Its locations stop appearing on new jobs; existing jobs are not changed." pending={toggleFac.pending} onConfirm={() => toggleFac.run()} />
      : <Button tone="secondary" onClick={() => void toggleFac.run()}>Reactivate</Button>)}</>}>
      <ErrorAlert error={toggleFac.error ?? toggleLoc.error} />
      <QueryBoundary state={locs}>
        {(d) => (
          <>
            {d.locations.length === 0 && <p className="muted">No locations yet.</p>}
            {d.locations.map((l) => (
              <div key={l.id} className="card" style={{ background: 'var(--bg)' }}>
                <div className="row between">
                  <div><strong>{l.name}</strong> {!l.active && <Badge tone="warning">Inactive</Badge>}<br /><span className="muted small">{l.address_line1}, {l.city}, {l.state} {l.postal_code} · {l.timezone}</span></div>
                  {canEdit && <Button tone="secondary" onClick={() => void toggleLoc.run(l)}>{l.active ? 'Deactivate' : 'Reactivate'}</Button>}
                </div>
                <Departments base={`${base}/locations/${l.id}`} canEdit={canEdit} />
              </div>
            ))}
            {canEdit && <AddLocation base={base} onAdded={() => void locs.reload()} />}
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

export default function LocationsPage() {
  const { org, approved, can } = useOrg();
  const client = useClient();
  const facs = useApi<{ facilities: Fac[] }>(`/organizations/${org.id}/facilities`);
  const canEdit = approved && can('locations.manage');
  const [name, setName] = useState('');
  const [type, setType] = useState('hospital');
  const add = useAction(async () => { await client.post(`/organizations/${org.id}/facilities`, { name, facilityType: type }); setName(''); await facs.reload(); });
  return (
    <>
      <PageHeader title="Locations & departments" subtitle="Where your jobs and shifts take place." />
      {!approved && <Alert tone="info">You can add facilities, locations and departments once BSM approves your organization.</Alert>}
      {approved && !can('locations.manage') && <Alert tone="info">Your role can view locations but not change them.</Alert>}
      <QueryBoundary state={facs}>
        {(d) => (
          <>
            {d.facilities.length === 0 && <p className="muted">No facilities yet.</p>}
            {d.facilities.map((f) => <FacilityCard key={f.id} orgId={org.id} fac={f} canEdit={canEdit} reload={facs.reload} />)}
          </>
        )}
      </QueryBoundary>
      {canEdit && (
        <Card title="Add a facility">
          <form onSubmit={(e) => { e.preventDefault(); void add.run(); }} noValidate>
            <ErrorAlert error={add.error} />
            <div className="form-grid">
              <TextField label="Facility name" name="name" required value={name} onChange={setName} error={add.error} />
              <SelectField label="Type" name="facilityType" value={type} onChange={setType} options={TYPES} error={add.error} />
            </div>
            <Button type="submit" pending={add.pending} disabled={name.trim().length < 2}>Add facility</Button>
          </form>
        </Card>
      )}
    </>
  );
}
