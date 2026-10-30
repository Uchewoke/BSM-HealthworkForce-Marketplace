'use client';
import { useEffect, useState } from 'react';
import { Alert, Card, ConfirmButton, ErrorAlert, PageHeader, SelectField, TextField, US_STATE_CODES, titleCase, useAction, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

const MISSING_LABELS: Record<string, string> = { legalName: 'Legal name', contactEmail: 'Contact email', contactPhone: 'Contact phone', state: 'State' };

export default function SettingsPage() {
  const { org, reload, can } = useOrg();
  const client = useClient();
  const editable = ['draft', 'needs_information'].includes(org.status) && can('org.update');
  const [f, setF] = useState({ name: '', legalName: '', contactEmail: '', contactPhone: '', website: '', state: '' });
  const [saved, setSaved] = useState(false);
  useEffect(() => setF({ name: org.name, legalName: org.legal_name ?? '', contactEmail: org.contact_email ?? '', contactPhone: org.contact_phone ?? '', website: org.website ?? '', state: org.state ?? '' }), [org]);
  const save = useAction(async () => {
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
    await client.patch(`/organizations/${org.id}`, body);
    setSaved(true); await reload();
  });
  const submit = useAction(async () => { await client.post(`/organizations/${org.id}/submit`); await reload(); });
  const set = (k: keyof typeof f) => (v: string) => { setSaved(false); setF({ ...f, [k]: v }); };
  const missing: string[] | undefined = submit.error?.details?.missing;
  return (
    <>
      <PageHeader title="Organization profile" subtitle={`Status: ${titleCase(org.status)}`} />
      {!editable && <Alert tone="info">{['draft', 'needs_information'].includes(org.status) ? 'You do not have permission to edit the profile.' : 'The profile is locked while it is under review or after a decision.'}</Alert>}
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} noValidate>
          <ErrorAlert error={save.error} />
          {saved && <Alert tone="success">Saved.</Alert>}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0 }}>
            <div className="form-grid">
              <TextField label="Display name" name="name" required value={f.name} onChange={set('name')} error={save.error} />
              <TextField label="Legal name" name="legalName" required value={f.legalName} onChange={set('legalName')} error={save.error} hint="Required to submit for review." />
              <TextField label="Contact email" name="contactEmail" type="email" required value={f.contactEmail} onChange={set('contactEmail')} error={save.error} hint="Used by BSM reviewers if they need to reach you." />
              <TextField label="Contact phone" name="contactPhone" type="tel" required value={f.contactPhone} onChange={set('contactPhone')} error={save.error} />
              <TextField label="Website" name="website" type="url" value={f.website} onChange={set('website')} error={save.error} hint="Starts with https://" />
              <SelectField label="Primary state" name="state" required value={f.state} onChange={set('state')} placeholder="—" options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} error={save.error} />
            </div>
            {editable && <button type="submit" className="btn" disabled={save.pending}>{save.pending ? 'Saving…' : 'Save profile'}</button>}
          </fieldset>
        </form>
      </Card>
      {editable && can('org.submit_for_review') && (
        <Card title="Submit for review">
          <p>When your profile is complete, submit it for BSM review. While it is under review you cannot edit it. We review organizations to keep the marketplace trustworthy; approval is not a guarantee of anything beyond access to the platform.</p>
          {missing && <Alert tone="warning" title="Still needed">{missing.map((m) => MISSING_LABELS[m] ?? m).join(', ')}. Fill these in and save first.</Alert>}
          {submit.error && !missing && <ErrorAlert error={submit.error} />}
          <ConfirmButton tone="primary" label="Submit for review" message="Submit this organization for review? You will not be able to edit the profile until BSM responds." pending={submit.pending} onConfirm={() => submit.run()} />
        </Card>
      )}
    </>
  );
}
