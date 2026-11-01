'use client';
import { useState } from 'react';
import { AGENCY_ROLES, canGrantRole, FACILITY_ROLES } from '@bsm/permissions';
import { Alert, Button, Card, ConfirmButton, DataTable, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Member { id: string; user_id: string; role: string; full_name: string; email: string }
interface Inv { id: string; email: string; role: string; expires_at: string }

const ROLE_HELP: Record<string, string> = {
  facility_owner: 'Full control. Cannot be assigned here.', facility_admin: 'Manages the organization, team and locations.', hiring_manager: 'Posts jobs and manages applicants.',
  agency_owner: 'Full control. Cannot be assigned here.', agency_admin: 'Manages the agency, team and roster.', agency_recruiter: 'Manages the roster and submits candidates.',
  agency_finance: 'Billing (later release).', agency_read_only: 'Can view only.',
  recruiter: 'Reviews applicants and finds professionals.', scheduler: 'Manages jobs and shifts.', finance: 'Billing (later release).', read_only: 'Can view only.',
};

export default function TeamPage() {
  const { org, can } = useOrg();
  const client = useClient();
  const members = useApi<{ members: Member[] }>(`/organizations/${org.id}/members`);
  const invites = useApi<{ invitations: Inv[] }>(can('members.invite') ? `/organizations/${org.id}/invitations` : null);
  const roles: readonly string[] = org.type === 'agency' ? AGENCY_ROLES : FACILITY_ROLES;
  const grantable = roles.filter((r) => r !== 'facility_owner' && r !== 'agency_owner' && canGrantRole(org.role, r));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(grantable[0] ?? 'read_only');
  const [sent, setSent] = useState('');
  const invite = useAction(async () => { await client.post(`/organizations/${org.id}/invitations`, { email, role }); setSent(email); setEmail(''); await invites.reload(); });
  const changeRole = useAction(async (id: string, r: string) => { await client.patch(`/organizations/${org.id}/members/${id}`, { role: r }); await members.reload(); });
  const remove = useAction(async (id: string) => { await client.delete(`/organizations/${org.id}/members/${id}`); await members.reload(); });
  const revoke = useAction(async (id: string) => { await client.delete(`/organizations/${org.id}/invitations/${id}`); await invites.reload(); });
  return (
    <>
      <PageHeader title="Team & invitations" />
      <Card title="Members">
        <ErrorAlert error={changeRole.error ?? remove.error} />
        <QueryBoundary state={members}>
          {(d) => <DataTable caption="Team members" rows={d.members} rowKey={(m) => m.id}
            columns={[
              { header: 'Name', cell: (m) => m.full_name }, { header: 'Email', cell: (m) => m.email },
              { header: 'Role', cell: (m) => can('members.manage') && canGrantRole(org.role, m.role) ? (
                <SelectField label={`Role for ${m.full_name}`} name={`role-${m.id}`} value={m.role} onChange={(v) => void changeRole.run(m.id, v)} options={[m.role, ...grantable.filter((g) => g !== m.role)].map((r) => ({ value: r, label: titleCase(r) }))} />
              ) : titleCase(m.role) },
              { header: 'Actions', cell: (m) => can('members.manage') && canGrantRole(org.role, m.role) ? <ConfirmButton label="Remove" message={`Remove ${m.full_name} from the organization?`} pending={remove.pending} onConfirm={() => remove.run(m.id)} /> : <span className="muted small">—</span> },
            ]} />}
        </QueryBoundary>
        <p className="small muted">You can only change roles whose permissions are within your own. Ownership cannot be transferred here.</p>
      </Card>
      {can('members.invite') && (
        <>
          <Card title="Invite a team member">
            {org.status === 'rejected' || org.status === 'suspended' ? <Alert tone="warning">This organization cannot invite members right now.</Alert> : (
              <form onSubmit={(e) => { e.preventDefault(); setSent(''); void invite.run(); }} noValidate>
                <ErrorAlert error={invite.error} />
                {sent && <Alert tone="success">Invitation sent to {sent}. It expires in 7 days and works only for that email address.</Alert>}
                <div className="form-grid">
                  <TextField label="Email address" name="email" type="email" required value={email} onChange={setEmail} error={invite.error} />
                  <SelectField label="Role" name="role" value={role} onChange={setRole} options={grantable.map((r) => ({ value: r, label: titleCase(r) }))} error={invite.error} hint={ROLE_HELP[role]} />
                </div>
                <Button type="submit" pending={invite.pending} disabled={!email}>Send invitation</Button>
              </form>
            )}
          </Card>
          <Card title="Pending invitations">
            <ErrorAlert error={revoke.error} />
            <QueryBoundary state={invites}>
              {(d) => <DataTable caption="Pending invitations" rows={d.invitations} rowKey={(i) => i.id} empty={<p className="muted">No pending invitations.</p>}
                columns={[
                  { header: 'Email', cell: (i) => i.email }, { header: 'Role', cell: (i) => titleCase(i.role) }, { header: 'Expires', cell: (i) => formatDateTime(i.expires_at) },
                  { header: 'Actions', cell: (i) => <ConfirmButton label="Revoke" message={`Revoke the invitation to ${i.email}?`} onConfirm={() => revoke.run(i.id)} /> },
                ]} />}
            </QueryBoundary>
          </Card>
        </>
      )}
    </>
  );
}
