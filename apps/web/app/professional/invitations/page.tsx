'use client';
import { Alert, Badge, Card, ConfirmButton, EmptyState, ErrorAlert, LinkButton, PageHeader, QueryBoundary, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Inv { id: string; status: string; message: string | null; created_at: string; expires_at: string; job_id: string; job_title: string; organization_name: string; city: string; state: string; job_open: boolean }

export default function InvitationsPage() {
  const client = useClient();
  const list = useApi<{ invitations: Inv[] }>('/professionals/me/invitations');
  const decline = useAction(async (id: string) => { await client.post(`/professionals/me/invitations/${id}/decline`); await list.reload(); });
  return (
    <>
      <PageHeader title="Invitations to apply" subtitle="Facilities can invite you only if you chose to be discoverable. Replying is always your choice." />
      <ErrorAlert error={decline.error} />
      <QueryBoundary state={list}>
        {(d) => d.invitations.length === 0 ? <EmptyState title="No invitations">When a facility invites you to apply, it will show up here and in your notifications.</EmptyState> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {d.invitations.map((i) => (
              <li key={i.id}>
                <Card title={i.job_title} actions={<Badge tone={i.status === 'pending' ? 'info' : 'neutral'}>{titleCase(i.status)}</Badge>}>
                  <p className="muted">{i.organization_name} · {i.city}, {i.state} · invited {formatDateTime(i.created_at)}</p>
                  {i.message && <blockquote style={{ margin: '8px 0', paddingLeft: 12, borderLeft: '3px solid var(--border)' }}>{i.message}</blockquote>}
                  {i.status === 'pending' && (
                    i.job_open ? (
                      <div className="row"><LinkButton href={`/professional/jobs/${i.job_id}`}>View job and apply</LinkButton>
                        <ConfirmButton label="Decline" message="Decline this invitation? The facility will not learn who you are." onConfirm={() => decline.run(i.id)} /></div>
                    ) : <Alert tone="warning">This job is no longer open.</Alert>
                  )}
                  {i.status === 'applied' && <p className="small muted">You applied. Track it under My applications.</p>}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </>
  );
}
