'use client';
import { useState } from 'react';
import { Card, ErrorAlert, PageHeader, SelectField, TextField, US_STATE_CODES, useAction, useClient } from '@bsm/ui';

export default function NewCredentialPage() {
  const client = useClient();
  const [f, setF] = useState({ kind: 'license', credentialType: '', jurisdiction: '', issuingAuthority: '', number: '', issueDate: '', expirationDate: '' });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const create = useAction(async () => {
    const res = await client.post<{ credential: { id: string } }>('/professionals/me/credentials', {
      kind: f.kind, credentialType: f.credentialType, jurisdiction: f.jurisdiction || undefined, issuingAuthority: f.issuingAuthority || undefined,
      number: f.number || undefined, issueDate: f.issueDate || undefined, expirationDate: f.expirationDate || undefined,
    });
    window.location.assign(`/professional/credentials/${res.credential.id}`);
  });
  return (
    <>
      <PageHeader title="Add a credential" />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void create.run(); }} noValidate>
          <ErrorAlert error={create.error} />
          <div className="form-grid">
            <SelectField label="Kind" name="kind" value={f.kind} onChange={set('kind')} options={[{ value: 'license', label: 'License' }, { value: 'certification', label: 'Certification' }]} error={create.error} />
            <TextField label="Credential type" name="credentialType" required value={f.credentialType} onChange={set('credentialType')} error={create.error} hint="For example RN, LPN, BLS, ACLS. Jobs match on this name." />
            <SelectField label="State (required for licenses)" name="jurisdiction" required={f.kind === 'license'} value={f.jurisdiction} onChange={set('jurisdiction')} placeholder="—"
              options={US_STATE_CODES.map((s) => ({ value: s, label: s }))} error={create.error} />
            <TextField label="Issuing authority" name="issuingAuthority" value={f.issuingAuthority} onChange={set('issuingAuthority')} error={create.error} />
            <TextField label="Credential number" name="number" value={f.number} onChange={set('number')} autoComplete="off" error={create.error}
              hint="Stored encrypted. After saving, only the last four characters are shown to you; facilities never see it." />
            <TextField label="Issue date" name="issueDate" type="date" value={f.issueDate} onChange={set('issueDate')} error={create.error} />
            <TextField label="Expiration date" name="expirationDate" type="date" value={f.expirationDate} onChange={set('expirationDate')} error={create.error} hint="Expired credentials cannot satisfy a job requirement." />
          </div>
          <button type="submit" className="btn" disabled={create.pending || !f.credentialType || (f.kind === 'license' && !f.jurisdiction)}>{create.pending ? 'Saving…' : 'Save credential'}</button>
        </form>
      </Card>
    </>
  );
}
