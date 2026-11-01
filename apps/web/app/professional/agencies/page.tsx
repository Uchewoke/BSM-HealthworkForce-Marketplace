'use client';
import { Alert, Badge, Button, Card, ConfirmButton, EmptyState, ErrorAlert, PageHeader, QueryBoundary, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Row { id: string; status: string; created_at: string; agency_name: string }

export default function AgenciesPage() {
  const client = useClient();
  const list = useApi<{ agencies: Row[] }>('/professionals/me/agencies');
  const respond = useAction(async (id: string, response: 'accept' | 'decline') => { await client.post(`/professionals/me/agencies/${id}/respond`, { response }); await list.reload(); });
  const leave = useAction(async (id: string) => { await client.delete(`/professionals/me/agencies/${id}`); await list.reload(); });
  return (
    <>
      <PageHeader title="Staffing agencies" subtitle="An agency can submit you for jobs only after you accept its invitation. You can leave at any time." />
      <Alert tone="info">Joining an agency does not share your credential documents with it. Facilities still see your credential status only, never the documents.</Alert>
      <ErrorAlert error={respond.error ?? leave.error} />
      <QueryBoundary state={list}>
        {(d) => d.agencies.length === 0 ? <EmptyState title="No agency invitations">If a staffing agency invites you, it will appear here and in your notifications.</EmptyState> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {d.agencies.map((a) => (
              <li key={a.id}>
                <Card title={a.agency_name} actions={<Badge tone={a.status === 'active' ? 'success' : 'info'}>{a.status === 'active' ? 'On roster' : 'Invitation'}</Badge>}>
                  <p className="muted">{a.status === 'invited' ? `Invited ${formatDateTime(a.created_at)}` : `${titleCase(a.status)} since ${formatDateTime(a.created_at)}`}</p>
                  {a.status === 'invited' ? (
                    <div className="row">
                      <Button pending={respond.pending} onClick={() => void respond.run(a.id, 'accept')}>Accept and join roster</Button>
                      <ConfirmButton label="Decline" message={`Decline the invitation from ${a.agency_name}?`} onConfirm={() => respond.run(a.id, 'decline')} />
                    </div>
                  ) : <ConfirmButton label="Leave this agency" message={`Leave ${a.agency_name}? It will no longer be able to submit you for jobs. Existing applications are not affected.`} pending={leave.pending} onConfirm={() => leave.run(a.id)} />}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </>
  );
}
