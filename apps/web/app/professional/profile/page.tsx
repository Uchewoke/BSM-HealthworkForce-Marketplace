'use client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CheckField, CheckGroup, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextArea, TextField, US_STATE_CODES, useAction, useApi, useClient } from '@bsm/ui';

interface Me {
  professional: { headline: string | null; summary: string | null; phone: string | null; city: string | null; state: string | null; discoverable: boolean };
  profession: { id: string; name: string };
  specialties: { id: string; name: string }[];
}

function ProfileForm({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const client = useClient();
  const taxonomy = useApi<{ professions: { id: string; specialties: { id: string; name: string }[] }[] }>('/taxonomies/professions');
  const [f, setF] = useState({ headline: '', summary: '', phone: '', city: '', state: '' });
  const [specialtyIds, setSpecialtyIds] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const p = me.professional;
    setF({ headline: p.headline ?? '', summary: p.summary ?? '', phone: p.phone ?? '', city: p.city ?? '', state: p.state ?? '' });
    setSpecialtyIds(me.specialties.map((s) => s.id));
  }, [me]);
  const save = useAction(async () => {
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
    if (Object.keys(body).length) await client.patch('/professionals/me', body);
    await client.put('/professionals/me/specialties', { specialtyIds });
    setSaved(true); await reload();
  });
  const options = taxonomy.data?.professions.find((p) => p.id === me.profession.id)?.specialties ?? [];
  const set = (k: keyof typeof f) => (v: string) => { setSaved(false); setF({ ...f, [k]: v }); };
  return (
    <Card title="Your details">
      <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
        <ErrorAlert error={save.error} />
        {saved && <Alert tone="success">Saved.</Alert>}
        <p><strong>Profession:</strong> {me.profession.name}</p>
        <TextField label="Headline" name="headline" value={f.headline} onChange={set('headline')} maxLength={160} error={save.error} hint="Shown to a facility only after you apply to its job." />
        <TextArea label="Summary" name="summary" value={f.summary} onChange={set('summary')} maxLength={4000} error={save.error} hint="Shown to a facility only after you apply. Do not include contact details here." />
        <div className="form-grid">
          <TextField label="Phone" name="phone" type="tel" value={f.phone} onChange={set('phone')} error={save.error} />
          <TextField label="City" name="city" value={f.city} onChange={set('city')} error={save.error} />
          <SelectField label="State" name="state" value={f.state} onChange={set('state')} placeholder="—" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} error={save.error} />
        </div>
        {options.length > 0 && <CheckGroup legend="Specialties" options={options.map((s) => ({ value: s.id, label: s.name }))} value={specialtyIds} onChange={(v) => { setSaved(false); setSpecialtyIds(v); }} />}
        <Button type="submit" pending={save.pending}>Save changes</Button>
      </form>
    </Card>
  );
}

function Visibility({ discoverable, reload }: { discoverable: boolean; reload: () => Promise<void> }) {
  const client = useClient();
  const [on, setOn] = useState(discoverable);
  useEffect(() => setOn(discoverable), [discoverable]);
  const save = useAction(async () => { await client.put('/professionals/me/discoverability', { discoverable: on }); await reload(); });
  return (
    <Card title="Let facilities find me">
      <p>Status: {discoverable ? <Badge tone="info">Discoverable</Badge> : <Badge tone="neutral">Not discoverable</Badge>}</p>
      <p>If you turn this on, approved facilities can find an <strong>anonymized</strong> summary of your profile and invite you to apply to a job. You choose whether to respond.</p>
      <details>
        <summary>Exactly what facilities can and cannot see</summary>
        <p><strong>They can see:</strong> your profession, specialties, city and state, years of experience, the status of your licenses and certifications (for example “verified” and how), and your general availability and work preferences.</p>
        <p><strong>They cannot see:</strong> your name, email, phone, photo, employers, schools, summary, pay expectation, credential numbers or documents. Your identity is shared only if you apply to a job.</p>
      </details>
      <ErrorAlert error={save.error} />
      <CheckField label="Make me discoverable by approved facilities" checked={on} onChange={setOn} hint="You can turn this off at any time. Invitations already sent stay visible to you." />
      <Button pending={save.pending} onClick={() => void save.run()} disabled={on === discoverable}>Save visibility</Button>
    </Card>
  );
}

export default function ProfilePage() {
  const me = useApi<Me>('/professionals/me');
  return (
    <>
      <PageHeader title="Profile & visibility" />
      <QueryBoundary state={me}>
        {(d) => (<><ProfileForm me={d} reload={me.reload} /><Visibility discoverable={d.professional.discoverable} reload={me.reload} /></>)}
      </QueryBoundary>
    </>
  );
}
