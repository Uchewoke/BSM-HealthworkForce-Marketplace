'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, ConfirmButton, ErrorAlert, PageHeader, QueryBoundary, RequireAuth, TextArea, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Detail { ticket: { id: string; subject: string; category: string; status: string }; messages: { id: string; author_kind: string; body: string; created_at: string }[] }

function Ticket() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const state = useApi<Detail>(`/support/tickets/${id}`);
  const [body, setBody] = useState('');
  const reply = useAction(async () => { await client.post(`/support/tickets/${id}/messages`, { body }); setBody(''); await state.reload(); });
  const close = useAction(async () => { await client.post(`/support/tickets/${id}/close`); await state.reload(); });
  return (
    <>
      <p><Link href="/support">← All requests</Link></p>
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <PageHeader title={d.ticket.subject} subtitle={<>{titleCase(d.ticket.category)} · <Badge tone={d.ticket.status === 'closed' ? 'neutral' : 'info'}>{d.ticket.status === 'pending_user' ? 'Waiting for you' : titleCase(d.ticket.status)}</Badge></>} />
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {d.messages.map((m) => (
                <li key={m.id}><Card><p className="small muted"><strong>{m.author_kind === 'staff' ? 'BSM Support' : 'You'}</strong> · {formatDateTime(m.created_at)}</p><p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p></Card></li>
              ))}
            </ul>
            {d.ticket.status !== 'closed' ? (
              <Card title="Reply">
                <form onSubmit={(e) => { e.preventDefault(); void reply.run(); }}>
                  <ErrorAlert error={reply.error ?? close.error} />
                  <TextArea label="Your message" name="body" required value={body} onChange={setBody} maxLength={4000} />
                  <div className="row between">
                    <button type="submit" className="btn" disabled={reply.pending || !body}>{reply.pending ? 'Sending…' : 'Send reply'}</button>
                    <ConfirmButton label="Close request" message="Close this request? You can open a new one later if you still need help." pending={close.pending} onConfirm={() => close.run()} />
                  </div>
                </form>
              </Card>
            ) : <p className="muted">This request is closed. Open a new one from the Support page if you still need help.</p>}
          </>
        )}
      </QueryBoundary>
    </>
  );
}

export default function TicketPage() {
  return <RequireAuth><Ticket /></RequireAuth>;
}
