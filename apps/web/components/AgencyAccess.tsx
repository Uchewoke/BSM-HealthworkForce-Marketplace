'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmButton, DataTable, ErrorAlert, QueryBoundary, SelectField, TextField, formatDateTime, useAction, useApi, useClient } from '@bsm/ui';

interface Grant { agency_id: string; name: string; status: string; created_at: string }

/** Lets a facility choose which staffing agencies may submit candidates for one job. Agencies see only jobs granted here. */
export function AgencyAccess({ orgId, jobId, canManage, published }: { orgId: string; jobId: string; canManage: boolean; published: boolean }) {
  const client = useClient();
  const grants = useApi<{ agencies: Grant[] }>(`/organizations/${orgId}/jobs/${jobId}/agencies`);
  const [q, setQ] = useState('');
  const found = useApi<{ agencies: { id: string; name: string }[] }>(q.trim().length >= 2 ? `/organizations/${orgId}/agencies` : null, { q: q.trim() });
  const [agencyId, setAgencyId] = useState('');
  const grant = useAction(async () => { await client.post(`/organizations/${orgId}/jobs/${jobId}/agencies`, { agencyId }); setAgencyId(''); await grants.reload(); });
  const revoke = useAction(async (id: string) => { await client.delete(`/organizations/${orgId}/jobs/${jobId}/agencies/${id}`); await grants.reload(); });
  const options = (found.data?.agencies ?? []).map((a) => ({ value: a.id, label: a.name }));
  return (
    <Card title="Staffing agencies">
      <p className="muted">Agencies you choose can submit candidates from their own roster for this job. Every submission goes through the same eligibility check as a direct application.</p>
      {!published && <Alert tone="info">Agencies can only see this job while it is published.</Alert>}
      <ErrorAlert error={revoke.error} />
      <QueryBoundary state={grants}>
        {(d) => <DataTable caption="Agencies with access" rows={d.agencies} rowKey={(g) => g.agency_id} empty={<p className="muted">No agency has access to this job.</p>}
          columns={[
            { header: 'Agency', cell: (g) => g.name },
            { header: 'Access', cell: (g) => <Badge tone={g.status === 'active' ? 'success' : 'neutral'}>{g.status === 'active' ? 'Active' : 'Revoked'}</Badge> },
            { header: 'Since', cell: (g) => formatDateTime(g.created_at) },
            { header: 'Actions', cell: (g) => canManage && g.status === 'active'
              ? <ConfirmButton label="Revoke" message={`Revoke ${g.name}'s access to this job? Submissions already made stay in your applications.`} pending={revoke.pending} onConfirm={() => revoke.run(g.agency_id)} />
              : <span className="muted small">—</span> },
          ]} />}
      </QueryBoundary>
      {canManage && (
        <form onSubmit={(e) => { e.preventDefault(); void grant.run(); }} noValidate>
          <ErrorAlert error={grant.error} />
          <div className="form-grid">
            <TextField label="Find an agency by name" name="agencySearch" value={q} onChange={(v) => { setQ(v); setAgencyId(''); }} hint="Only approved agencies appear." />
            {options.length > 0 && <SelectField label="Agency" name="agencyId" value={agencyId} onChange={setAgencyId} options={options} placeholder="Choose an agency" />}
          </div>
          {q.trim().length >= 2 && !found.loading && options.length === 0 && <p className="small muted">No approved agency matches that name.</p>}
          <Button type="submit" pending={grant.pending} disabled={!agencyId}>Give access</Button>
        </form>
      )}
    </Card>
  );
}
