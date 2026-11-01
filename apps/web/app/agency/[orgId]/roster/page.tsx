'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmButton, DataTable, ErrorAlert, PageHeader, QueryBoundary, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

interface Row { id: string; status: string; created_at: string; responded_at: string | null; full_name: string; profession: string; city: string | null; state: string | null }
const TONE: Record<string, 'info' | 'success' | 'neutral'> = { invited: 'info', active: 'success', declined: 'neutral' };

export default function RosterPage() {
  const { org, can, approved } = useOrg();
  const client = useClient();
  const roster = useApi<{ roster: Row[] }>(`/organizations/${org.id}/agency/roster`);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const invite = useAction(async () => { await client.post(`/organizations/${org.id}/agency/roster/invitations`, { email }); setSent(true); setEmail(''); await roster.reload(); });
  const remove = useAction(async (id: string) => { await client.delete(`/organizations/${org.id}/agency/roster/${id}`); await roster.reload(); });
  return (
    <>
      <PageHeader title="Roster" subtitle="Professionals who have agreed to be represented by your agency." />
      <Card title="Invite a professional">
        {!approved ? <Alert tone="info">You can invite professionals once BSM has approved your agency.</Alert> : !can('agency.roster.manage') ? <Alert tone="info">Your role can view the roster but not change it.</Alert> : (
          <form onSubmit={(e) => { e.preventDefault(); setSent(false); void invite.run(); }} noValidate>
            <ErrorAlert error={invite.error} />
            {sent && <Alert tone="success">If that email belongs to a professional on BSM, they have been invited. For privacy we do not say whether an account exists. Ask them to register first if you hear nothing.</Alert>}
            <TextField label="Professional's email address" name="email" type="email" required value={email} onChange={setEmail} error={invite.error} hint="They must accept before you can submit them for any job." />
            <Button type="submit" pending={invite.pending} disabled={!email}>Send invitation</Button>
          </form>
        )}
      </Card>
      <Card title="Roster members">
        <ErrorAlert error={remove.error} />
        <QueryBoundary state={roster}>
          {(d) => <DataTable caption="Roster" rows={d.roster} rowKey={(r) => r.id} empty={<p className="muted">No one on your roster yet.</p>}
            columns={[
              { header: 'Name', cell: (r) => r.full_name }, { header: 'Profession', cell: (r) => r.profession },
              { header: 'Location', cell: (r) => [r.city, r.state].filter(Boolean).join(', ') || '—' },
              { header: 'Status', cell: (r) => <Badge tone={TONE[r.status] ?? 'neutral'}>{titleCase(r.status)}</Badge> },
              { header: 'Since', cell: (r) => formatDateTime(r.responded_at ?? r.created_at) },
              { header: 'Actions', cell: (r) => can('agency.roster.manage') ? <ConfirmButton label={r.status === 'invited' ? 'Withdraw' : 'Remove'} message={`${r.status === 'invited' ? 'Withdraw the invitation to' : 'Remove'} ${r.full_name}?`} pending={remove.pending} onConfirm={() => remove.run(r.id)} /> : <span className="muted small">—</span> },
            ]} />}
        </QueryBoundary>
      </Card>
    </>
  );
}
