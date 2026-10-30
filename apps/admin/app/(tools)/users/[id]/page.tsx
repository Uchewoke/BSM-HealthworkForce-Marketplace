'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { platformRoleCan } from '@bsm/permissions';
import { Alert, Badge, Card, ConfirmButton, DataTable, DefinitionList, ErrorAlert, OrgStatusBadge, PageHeader, QueryBoundary, TextArea, formatDateTime, titleCase, useAction, useApi, useClient, useSession } from '@bsm/ui';

interface Detail {
  user: { id: string; email: string; full_name: string; status: string; platform_role: string | null; email_verified_at: string | null; failed_login_count: number; locked_until: string | null; created_at: string };
  memberships: { id: string; role: string; status: string; organization_id: string; organization_name: string; organization_status: string }[];
  professional: null | { id: string; account_status: string; profession: string };
  activeSessions: number;
}

function StatusForm({ d, reload }: { d: Detail; reload: () => Promise<void> }) {
  const client = useClient();
  const [reason, setReason] = useState('');
  const next = d.user.status === 'active' ? 'suspended' : 'active';
  const change = useAction(async () => { await client.post(`/admin/users/${d.user.id}/status`, { status: next, reason }); setReason(''); await reload(); });
  return (
    <Card title={next === 'suspended' ? 'Suspend this account' : 'Reactivate this account'}>
      <ErrorAlert error={change.error} />
      {next === 'suspended' && <Alert tone="warning">Suspending signs the user out of every device immediately and blocks sign-in. Their data is kept.</Alert>}
      <TextArea label="Reason (recorded in the audit log)" name="reason" required value={reason} onChange={setReason} rows={3} maxLength={1000} />
      {reason.trim().length < 3 ? <button className="btn secondary" disabled>{next === 'suspended' ? 'Suspend account' : 'Reactivate account'}</button>
        : <ConfirmButton tone={next === 'suspended' ? 'danger' : 'primary'} label={next === 'suspended' ? 'Suspend account' : 'Reactivate account'} message={`${next === 'suspended' ? 'Suspend' : 'Reactivate'} ${d.user.email}?`} pending={change.pending} onConfirm={() => change.run()} />}
    </Card>
  );
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Detail>(`/admin/users/${id}`);
  const { user: me } = useSession();
  const canManage = !!me?.platformRole && platformRoleCan(me.platformRole, 'admin.user_manage');
  return (
    <>
      <p><Link href="/users">← Search</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.user.full_name} subtitle={<>{d.user.email} · <Badge tone={d.user.status === 'active' ? 'success' : 'danger'}>{titleCase(d.user.status)}</Badge></>} />
            <Card title="Account">
              <DefinitionList items={[
                ['Staff role', d.user.platform_role ? titleCase(d.user.platform_role) : '—'], ['Email verified', d.user.email_verified_at ? formatDateTime(d.user.email_verified_at) : 'No'],
                ['Joined', formatDateTime(d.user.created_at)], ['Active sessions', d.activeSessions], ['Failed sign-ins', d.user.failed_login_count], ['Locked until', d.user.locked_until ? formatDateTime(d.user.locked_until) : '—'],
              ]} />
              <p className="small muted">Viewing this page is recorded in the audit log.</p>
            </Card>
            <Card title="Professional profile">{d.professional ? <p>{d.professional.profession} · account {titleCase(d.professional.account_status)}</p> : <p className="muted">No professional profile.</p>}</Card>
            <Card title="Organizations">
              <DataTable caption="Memberships" rows={d.memberships} rowKey={(m) => m.id} empty={<p className="muted">Not a member of any organization.</p>}
                columns={[
                  { header: 'Organization', cell: (m) => <Link href={`/organizations/${m.organization_id}`}>{m.organization_name}</Link> }, { header: 'Role', cell: (m) => titleCase(m.role) },
                  { header: 'Membership', cell: (m) => titleCase(m.status) }, { header: 'Organization status', cell: (m) => <OrgStatusBadge status={m.organization_status} /> },
                ]} />
            </Card>
            {canManage ? <StatusForm d={d} reload={state.reload} /> : <Alert tone="info">Your role can view accounts but not suspend or reactivate them.</Alert>}
          </>
        )}
      </QueryBoundary>
    </>
  );
}
