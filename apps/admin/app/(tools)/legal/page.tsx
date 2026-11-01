'use client';
import { useState } from 'react';
import { Alert, Badge, Card, ConfirmButton, ErrorAlert, PageHeader, QueryBoundary, TextField, formatDateTime, useAction, useApi, useClient } from '@bsm/ui';

interface Signoff { feature: string; label: string; signedOff: boolean; reference: string | null; note: string | null; signedOffAt: string | null; signedOffBy: string | null }

const WHAT_IT_DOES: Record<string, string> = {
  float_pool: 'While switched off, professionals cannot join a regional pool, facilities cannot join an exchange or see the pool, and no pool request can be sent or accepted. Switching it off again withdraws every request still waiting.',
  shift_recovery: 'While switched off, no organization can turn on automatic outreach, and the automatic checks send nothing, even for organizations that had already switched it on. Offers already sent stay open.',
};

function Feature({ s, reload }: { s: Signoff; reload: () => Promise<void> }) {
  const client = useClient();
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const save = useAction(async (signedOff: boolean) => {
    await client.put(`/admin/legal-signoffs/${s.feature}`, { signedOff, reference: reference.trim() || undefined, note: note.trim() || undefined });
    setReference(''); setNote(''); await reload();
  });
  return (
    <Card title={s.label} actions={<Badge tone={s.signedOff ? 'success' : 'warning'}>{s.signedOff ? 'Signed off' : 'Switched off'}</Badge>}>
      <p>{WHAT_IT_DOES[s.feature]}</p>
      {s.signedOff && <p className="small muted">Signed off by {s.signedOffBy ?? 'unknown'} on {formatDateTime(s.signedOffAt)}.{s.reference ? <> Reference: <strong>{s.reference}</strong>.</> : null}{s.note ? ` ${s.note}` : ''}</p>}
      {!s.signedOff && s.reference && <p className="small muted">Last recorded reference: {s.reference}. {s.note}</p>}
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label={s.signedOff ? 'Reason for switching it off (optional)' : 'Where the legal review is recorded (required)'} name={`ref-${s.feature}`} value={reference} onChange={setReference} maxLength={300}
          hint={s.signedOff ? undefined : 'A memo, ticket or document id someone can find later.'} error={save.error} />
        <TextField label="Note (optional)" name={`note-${s.feature}`} value={note} onChange={setNote} maxLength={1000} />
      </div>
      {s.signedOff
        ? <ConfirmButton label="Switch off" message="Switch this feature off for everyone? Anything waiting on it is withdrawn." pending={save.pending} onConfirm={() => save.run(false)} />
        : <ConfirmButton tone="primary" label="Record sign-off and switch on" message="Confirm that BSM's legal review of this feature is complete, and switch it on for all organizations?" pending={save.pending} onConfirm={() => (reference.trim().length >= 3 ? save.run(true) : Promise.resolve())} />}
      {!s.signedOff && reference.trim().length < 3 && <p className="small muted">Enter the reference first.</p>}
    </Card>
  );
}

export default function LegalPage() {
  const state = useApi<{ signoffs: Signoff[] }>('/admin/legal-signoffs');
  return (
    <>
      <PageHeader title="Legal sign-off" subtitle="Features that stay switched off until legal review is recorded as complete." />
      <Alert tone="info" title="What this is">
        This records that someone at BSM says the legal review is finished, who, when, and where it is written down. It does not make anything lawful by itself. Every change is in the audit log. Only super admins can change it.
      </Alert>
      <QueryBoundary state={state}>
        {(d) => <ul style={{ listStyle: 'none', padding: 0 }}>{d.signoffs.map((s) => <li key={s.feature}><Feature s={s} reload={state.reload} /></li>)}</ul>}
      </QueryBoundary>
    </>
  );
}
