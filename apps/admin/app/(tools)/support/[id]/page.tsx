'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CheckField, DefinitionList, ErrorAlert, PageHeader, QueryBoundary, SelectField, TextArea, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Detail {
  ticket: { id: string; subject: string; category: string; status: string; priority: string; related_type: string | null; related_id: string | null; organization_id: string | null; assigned_to: string | null; requester_name: string; requester_email: string; created_at: string };
  messages: { id: string; author_kind: string; internal: boolean; body: string; created_at: string }[];
}

export default function AdminTicketPage() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const state = useApi<Detail>(`/admin/support/tickets/${id}`);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const reply = useAction(async () => { await client.post(`/admin/support/tickets/${id}/messages`, { body, internal }); setBody(''); await state.reload(); });
  const assign = useAction(async (assignToMe: boolean) => { await client.post(`/admin/support/tickets/${id}/assign`, { assignToMe }); await state.reload(); });
  const setSt = useAction(async () => { await client.post(`/admin/support/tickets/${id}/status`, { status, priority: priority || undefined }); await state.reload(); });
  return (
    <>
      <p><Link href="/support">← Queue</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.ticket.subject} subtitle={<>{titleCase(d.ticket.category)} · <Badge tone="info">{titleCase(d.ticket.status)}</Badge> · <Badge tone={d.ticket.priority === 'urgent' ? 'danger' : 'neutral'}>{titleCase(d.ticket.priority)}</Badge></>} />
            <Card title="Requester">
              <DefinitionList items={[['Name', d.ticket.requester_name], ['Email', d.ticket.requester_email], ['Opened', formatDateTime(d.ticket.created_at)], ['Related item', d.ticket.related_type ? `${titleCase(d.ticket.related_type)} ${d.ticket.related_id ?? ''}` : null], ['Assigned', d.ticket.assigned_to ? 'Yes' : 'No']]} />
              <p className="small muted">Viewing this request was recorded in the audit log. The related item reference is supplied by the requester and is not checked.</p>
              <div className="row"><Button tone="secondary" pending={assign.pending} onClick={() => void assign.run(!d.ticket.assigned_to)}>{d.ticket.assigned_to ? 'Unassign' : 'Assign to me'}</Button></div>
            </Card>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {d.messages.map((m) => (
                <li key={m.id}>
                  <Card>
                    <p className="small muted"><strong>{m.author_kind === 'staff' ? 'Staff' : 'Requester'}</strong> · {formatDateTime(m.created_at)} {m.internal && <Badge tone="warning">Internal note: not visible to the requester</Badge>}</p>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
                  </Card>
                </li>
              ))}
            </ul>
            {d.ticket.status !== 'closed' ? (
              <>
                <Card title="Reply">
                  <form onSubmit={(e) => { e.preventDefault(); void reply.run(); }}>
                    <ErrorAlert error={reply.error ?? assign.error ?? setSt.error} />
                    <TextArea label="Message" name="body" required value={body} onChange={setBody} maxLength={4000} />
                    <CheckField label="Internal note (the requester will not see it)" checked={internal} onChange={setInternal} />
                    {!internal && <Alert tone="info">The requester is notified that you replied. The notification and email do not include your message text.</Alert>}
                    <Button type="submit" pending={reply.pending} disabled={!body.trim()}>{internal ? 'Add internal note' : 'Send reply'}</Button>
                  </form>
                </Card>
                <Card title="Status & priority">
                  <div className="form-grid">
                    <SelectField label="Set status" name="status" value={status} onChange={setStatus} placeholder="Choose…" options={['open', 'pending_user', 'resolved', 'closed'].map((s) => ({ value: s, label: titleCase(s) }))} />
                    <SelectField label="Priority" name="priority" value={priority} onChange={setPriority} placeholder="Unchanged" options={['low', 'normal', 'high', 'urgent'].map((s) => ({ value: s, label: titleCase(s) }))} />
                  </div>
                  <Button pending={setSt.pending} disabled={!status} onClick={() => void setSt.run()}>Update</Button>
                </Card>
              </>
            ) : <Alert tone="info">This request is closed.</Alert>}
          </>
        )}
      </QueryBoundary>
    </>
  );
}
