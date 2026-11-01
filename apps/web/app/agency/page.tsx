'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Card, DataTable, ErrorAlert, OrgStatusBadge, PageHeader, QueryBoundary, RequireAuth, TextField, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Org { id: string; name: string; type: string; status: string; role: string }

function Hub() {
  const client = useClient();
  const list = useApi<{ organizations: Org[] }>('/organizations');
  const [name, setName] = useState('');
  const create = useAction(async () => {
    const r = await client.post<{ organization: { id: string } }>('/organizations', { name, type: 'agency' });
    window.location.assign(`/agency/${r.organization.id}/settings`);
  });
  return (
    <>
      <PageHeader title="Staffing agencies" subtitle="Agencies you belong to." />
      <QueryBoundary state={list}>
        {(d) => (
          <DataTable caption="Your agencies" rows={d.organizations.filter((o) => o.type === 'agency')} rowKey={(o) => o.id} empty={<p className="muted">You are not a member of any agency yet.</p>}
            columns={[
              { header: 'Agency', cell: (o) => <Link href={`/agency/${o.id}`}>{o.name}</Link> },
              { header: 'Review status', cell: (o) => <OrgStatusBadge status={o.status} /> }, { header: 'Your role', cell: (o) => titleCase(o.role) },
            ]} />
        )}
      </QueryBoundary>
      <Card title="Register a new staffing agency">
        <Alert tone="info">BSM reviews every new organization before it can invite professionals or submit candidates. You will complete the agency profile and submit it for review on the next screen.</Alert>
        <form onSubmit={(e) => { e.preventDefault(); void create.run(); }} noValidate>
          <ErrorAlert error={create.error} />
          <TextField label="Agency name" name="name" required value={name} onChange={setName} error={create.error} />
          <button type="submit" className="btn" disabled={create.pending || name.trim().length < 2}>{create.pending ? 'Creating…' : 'Create agency'}</button>
        </form>
      </Card>
    </>
  );
}

export default function AgencyHubPage() {
  return <RequireAuth><Hub /></RequireAuth>;
}
