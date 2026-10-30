'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Card, CredentialStatusBadge, ErrorAlert, LinkButton, PageHeader, QueryBoundary, SelectField, TextArea, TextField, US_STATE_CODES, credentialLabel, useAction, useApi, useClient } from '@bsm/ui';

const SECTIONS: Record<string, { label: string; href: string; why: string }> = {
  specialties: { label: 'Choose your specialties', href: '/professional/profile', why: 'Facilities filter jobs by specialty.' },
  work_history: { label: 'Add education or work experience', href: '/professional/history', why: 'Used to check minimum-experience requirements.' },
  preferences: { label: 'Set your work preferences', href: '/professional/availability', why: 'Employment types, states and pay expectations.' },
  availability: { label: 'Add your weekly availability', href: '/professional/availability', why: 'Needed to confirm that a shift fits your schedule.' },
  credentials: { label: 'Add a license or certification', href: '/professional/credentials', why: 'Most jobs require a verified license.' },
};

function CreateProfile({ onCreated }: { onCreated: () => void }) {
  const client = useClient();
  const professions = useApi<{ professions: { id: string; name: string }[] }>('/taxonomies/professions');
  const [professionId, setProfessionId] = useState('');
  const [headline, setHeadline] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const create = useAction(async () => { await client.post('/professionals', { professionId, headline: headline || undefined, city: city || undefined, state: state || undefined }); onCreated(); });
  return (
    <>
      <PageHeader title="Create your professional profile" subtitle="You can work independently: no agency is required." />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void create.run(); }} noValidate>
          <ErrorAlert error={create.error} />
          <SelectField label="Profession" name="professionId" required value={professionId} onChange={setProfessionId} placeholder="Choose…" error={create.error}
            options={(professions.data?.professions ?? []).map((p) => ({ value: p.id, label: p.name }))} hint="This decides which jobs and specialties you can choose from." />
          <TextField label="Headline (optional)" name="headline" value={headline} onChange={setHeadline} maxLength={160} error={create.error} hint="Shown to facilities only after you apply." />
          <div className="form-grid">
            <TextField label="City" name="city" value={city} onChange={setCity} error={create.error} />
            <SelectField label="State" name="state" value={state} onChange={setState} placeholder="—" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} error={create.error} />
          </div>
          <button type="submit" className="btn" disabled={create.pending || !professionId}>{create.pending ? 'Creating…' : 'Create profile'}</button>
        </form>
      </Card>
    </>
  );
}

export default function ProfessionalHome() {
  const me = useApi<{ professional: { headline: string | null; discoverable: boolean }; profession: { name: string }; completeness: { complete: boolean; percent: number; missing: string[] }; credentialSummary: Record<string, number> }>('/professionals/me');
  if (me.error?.status === 404) return <CreateProfile onCreated={() => void me.reload()} />;
  return (
    <>
      <PageHeader title="Professional overview" />
      <QueryBoundary state={me}>
        {(d) => (
          <>
            <Card title={d.profession.name}>
              <p>
                Profile sections completed: <strong>{d.completeness.percent}%</strong>
                {d.completeness.complete ? ' — all sections filled in.' : '.'}{' '}
                <span className="muted">This measures how much you have filled in. It is not a verification of any credential.</span>
              </p>
              {d.completeness.missing.length > 0 && (
                <ul>{d.completeness.missing.map((m) => <li key={m}><Link href={SECTIONS[m]?.href ?? '/professional'}>{SECTIONS[m]?.label ?? m}</Link> <span className="muted small">— {SECTIONS[m]?.why}</span></li>)}</ul>
              )}
            </Card>
            <Card title="Credentials" actions={<LinkButton href="/professional/credentials" tone="secondary">Manage</LinkButton>}>
              {Object.keys(d.credentialSummary).length === 0 ? <p className="muted">No credentials yet.</p> : (
                <div className="row">{Object.entries(d.credentialSummary).map(([k, n]) => <span key={k} className="row"><CredentialStatusBadge status={k} label={credentialLabel(k, null)} /> <span className="muted">×{n}</span></span>)}</div>
              )}
              <p className="small muted">“Verified” always shows how it was checked, on each credential’s page.</p>
            </Card>
            <Card title="Visibility to facilities">
              <p>{d.professional.discoverable ? <Badge tone="info">Discoverable</Badge> : <Badge tone="neutral">Not discoverable</Badge>} <Link href="/professional/profile">Change</Link></p>
              <p className="small muted">Off by default. When on, approved facilities can find an anonymized summary of your profile and invite you to apply.</p>
            </Card>
            <Alert tone="info">Ready to look for work? <Link href="/professional/jobs">Find jobs</Link></Alert>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
