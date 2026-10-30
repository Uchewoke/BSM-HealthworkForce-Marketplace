'use client';
import { useState } from 'react';
import { Badge, Button, Card, CheckField, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, RequireAuth, formatDateTime, useAction, useApi, useClient } from '@bsm/ui';

interface N { id: string; title: string; body: string | null; read_at: string | null; created_at: string; email_status: string }

function Notifications() {
  const client = useClient();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useApi<{ notifications: N[]; total: number; pageSize: number }>('/notifications', { page, unread: unreadOnly ? 'true' : undefined });
  const markRead = useAction(async (id: string) => { await client.post(`/notifications/${id}/read`); await list.reload(); });
  const markAll = useAction(async () => { await client.post('/notifications/read-all'); await list.reload(); });
  return (
    <>
      <PageHeader title="Notifications" actions={<Button tone="secondary" pending={markAll.pending} onClick={() => void markAll.run()}>Mark all as read</Button>} />
      <CheckField label="Show unread only" checked={unreadOnly} onChange={(v) => { setUnreadOnly(v); setPage(1); }} />
      <ErrorAlert error={markRead.error ?? markAll.error} />
      <QueryBoundary state={list}>
        {(d) => d.notifications.length === 0 ? <EmptyState title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}>Updates about applications, reviews and support will appear here.</EmptyState> : (
          <>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {d.notifications.map((n) => (
                <li key={n.id}>
                  <Card>
                    <div className="row between">
                      <strong>{n.title}</strong>
                      {!n.read_at ? <Badge tone="info">New</Badge> : <span className="muted small">Read</span>}
                    </div>
                    {n.body && <p>{n.body}</p>}
                    <div className="row between">
                      <span className="muted small">{formatDateTime(n.created_at)}{n.email_status === 'not_delivered' ? ' · email not sent (no email service configured)' : ''}</span>
                      {!n.read_at && <Button tone="secondary" onClick={() => void markRead.run(n.id)}>Mark as read</Button>}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}

export default function NotificationsPage() {
  return <RequireAuth><Notifications /></RequireAuth>;
}
