'use client';
import { useEffect, useState } from 'react';
import { platformRoleCan } from '@bsm/permissions';
import { Alert, Badge, Button, Card, CheckField, ConfirmButton, DataTable, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextField, useAction, useApi, useClient, useSession } from '@bsm/ui';

const WEIGHT_LABELS: Record<string, string> = {
  specialty: 'Specialty relevance', experience: 'Experience relevance', location: 'Location preference', availability: 'Work-arrangement fit',
  compensation: 'Compensation compatibility', workHistory: 'Recent work history', completeness: 'Profile completeness',
};

function RankingWeights() {
  const client = useClient();
  const state = useApi<{ weights: Record<string, number>; version: number; defaults: Record<string, number>; rankingVersion: string }>('/admin/settings/ranking-weights');
  const [w, setW] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (state.data) setW(Object.fromEntries(Object.entries(state.data.weights).map(([k, v]) => [k, String(v)]))); }, [state.data]);
  const total = Object.values(w).reduce((a, v) => a + (Number(v) || 0), 0);
  const save = useAction(async () => { await client.put('/admin/settings/ranking-weights', Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v)]))); setSaved(true); await state.reload(); });
  return (
    <Card title="Ranking weights">
      <p className="muted">Weights only change the <strong>order of candidates who are already eligible</strong>. They can never make an ineligible person eligible. The defaults are a starting proposal that has not been validated; have them reviewed by domain and employment-law experts before relying on them.</p>
      <QueryBoundary state={state}>
        {(d) => (
          <form onSubmit={(e) => { e.preventDefault(); setSaved(false); void save.run(); }} noValidate>
            <ErrorAlert error={save.error} />
            {saved && <Alert tone="success">Saved. Changes apply to rankings immediately and are versioned (now version {d.version}).</Alert>}
            <div className="form-grid">
              {Object.keys(d.weights).map((k) => <TextField key={k} label={`${WEIGHT_LABELS[k] ?? k} (%)`} name={k} type="number" min={0} max={100} value={w[k] ?? ''} onChange={(v) => { setSaved(false); setW({ ...w, [k]: v }); }} error={save.error} hint={`Default ${d.defaults[k]}`} />)}
            </div>
            <p aria-live="polite"><Badge tone={total === 100 ? 'success' : 'danger'}>Total: {total}%</Badge> {total !== 100 && <span className="small">Weights must add up to 100.</span>}</p>
            <Button type="submit" pending={save.pending} disabled={total !== 100}>Save weights</Button>
          </form>
        )}
      </QueryBoundary>
    </Card>
  );
}

interface St { state: string; enabled: boolean; compactMember: boolean | null; notes: string | null; configured: boolean }
function States() {
  const client = useClient();
  const state = useApi<{ states: St[] }>('/admin/states');
  const [showAll, setShowAll] = useState(false);
  const toggle = useAction(async (s: St) => { await client.put(`/admin/states/${s.state}`, { enabled: !s.enabled, compactMember: s.compactMember, notes: s.notes }); await state.reload(); });
  return (
    <Card title="States">
      <p className="muted">All states are enabled by default. Disabling a state hides its jobs from search, blocks applications to them, and blocks publishing there. Existing data is kept.</p>
      <ErrorAlert error={toggle.error} />
      <CheckField label="Show all states (otherwise only changed or disabled ones)" checked={showAll} onChange={setShowAll} />
      <QueryBoundary state={state}>
        {(d) => {
          const rows = d.states.filter((s) => showAll || !s.enabled || s.configured);
          const disabled = d.states.filter((s) => !s.enabled).length;
          return (
            <>
              <p><Badge tone={disabled ? 'warning' : 'success'}>{disabled} disabled</Badge></p>
              <DataTable caption="States" rows={rows} rowKey={(s) => s.state} empty={<p className="muted">Every state is enabled with default settings.</p>}
                columns={[
                  { header: 'State', cell: (s) => s.state }, { header: 'Listings', cell: (s) => <Badge tone={s.enabled ? 'success' : 'danger'}>{s.enabled ? 'Enabled' : 'Disabled'}</Badge> }, { header: 'Notes', cell: (s) => s.notes ?? '—' },
                  { header: 'Actions', cell: (s) => (s.enabled
                    ? <ConfirmButton label={`Disable ${s.state}`} message={`Disable listings in ${s.state}? Existing jobs there will disappear from search immediately.`} pending={toggle.pending} onConfirm={() => toggle.run(s)} />
                    : <Button tone="secondary" pending={toggle.pending} onClick={() => void toggle.run(s)}>Enable</Button>) },
                ]} />
            </>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}

function Taxonomy() {
  const client = useClient();
  const state = useApi<{ professions: { id: string; code: string; name: string; specialties: { id: string; name: string }[] }[] }>('/taxonomies/professions');
  const [pf, setPf] = useState({ code: '', name: '' });
  const [sf, setSf] = useState({ professionId: '', name: '' });
  const addProfession = useAction(async () => { await client.post('/admin/taxonomies/professions', pf); setPf({ code: '', name: '' }); await state.reload(); });
  const addSpecialty = useAction(async () => { await client.post('/admin/taxonomies/specialties', sf); setSf({ ...sf, name: '' }); await state.reload(); });
  const deactivate = useAction(async (kind: 'professions' | 'specialties', id: string) => { await client.patch(`/admin/taxonomies/${kind}/${id}`, { active: false }); await state.reload(); });
  return (
    <Card title="Professions & specialties">
      <Alert tone="warning">The launch list of professions and specialties is a pending product decision; the starting data is a placeholder. Deactivating hides an item from new profiles and jobs but keeps existing records. This screen cannot list inactive items yet.</Alert>
      <ErrorAlert error={addProfession.error ?? addSpecialty.error ?? deactivate.error} />
      <QueryBoundary state={state}>
        {(d) => (
          <>
            {d.professions.map((p) => (
              <div key={p.id} className="card" style={{ background: 'var(--bg)' }}>
                <div className="row between"><strong>{p.name} <span className="muted small">({p.code})</span></strong>
                  <ConfirmButton label="Deactivate" message={`Deactivate ${p.name}? Professionals cannot choose it for new profiles and jobs cannot use it.`} onConfirm={() => deactivate.run('professions', p.id)} /></div>
                <ul>{p.specialties.map((s) => <li key={s.id}>{s.name} <ConfirmButton label="Deactivate" message={`Deactivate ${s.name}?`} onConfirm={() => deactivate.run('specialties', s.id)} /></li>)}</ul>
              </div>
            ))}
            <form onSubmit={(e) => { e.preventDefault(); void addProfession.run(); }} noValidate>
              <h3>Add a profession</h3>
              <div className="form-grid">
                <TextField label="Code" name="code" value={pf.code} onChange={(v) => setPf({ ...pf, code: v.toLowerCase() })} error={addProfession.error} hint="Lowercase letters, digits and underscore" />
                <TextField label="Name" name="name" value={pf.name} onChange={(v) => setPf({ ...pf, name: v })} error={addProfession.error} />
              </div>
              <Button type="submit" pending={addProfession.pending} disabled={!pf.code || !pf.name}>Add profession</Button>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); void addSpecialty.run(); }} noValidate>
              <h3>Add a specialty</h3>
              <div className="form-grid">
                <SelectField label="Profession" name="professionId" value={sf.professionId} onChange={(v) => setSf({ ...sf, professionId: v })} placeholder="Choose…" options={d.professions.map((p) => ({ value: p.id, label: p.name }))} error={addSpecialty.error} />
                <TextField label="Specialty name" name="name" value={sf.name} onChange={(v) => setSf({ ...sf, name: v })} error={addSpecialty.error} />
              </div>
              <Button type="submit" pending={addSpecialty.pending} disabled={!sf.professionId || !sf.name}>Add specialty</Button>
            </form>
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

export default function SettingsPage() {
  const { user } = useSession();
  const canWeights = !!user?.platformRole && platformRoleCan(user.platformRole, 'admin.settings_manage');
  return (
    <>
      <PageHeader title="Configuration" subtitle="States, taxonomy and ranking. Every change is recorded in the audit log." />
      <States />
      <Taxonomy />
      {canWeights ? <RankingWeights /> : <Alert tone="info">Ranking weights can be changed by super admins only.</Alert>}
    </>
  );
}
