'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, DataTable, ErrorAlert, PageHeader, Pagination, QueryBoundary, RequireAuth, SelectField, TextArea, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

const CATEGORIES = ['account', 'credential', 'job', 'application', 'dispute', 'other'].map((c) => ({ value: c, label: titleCase(c) }));
interface T { id: string; category: string; subject: string; status: string; updated_at: string }

function NewTicket({ onCreated }: { onCreated: () => void }) {
  const client = useClient();
  const [category, setCategory] = useState('account');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const create = useAction(async () => { await client.post('/support/tickets', { category, subject, body }); setSubject(''); setBody(''); onCreated(); });
  return (
    <Card title="Ask for help">
      <form onSubmit={(e) => { e.preventDefault(); void create.run(); }} noValidate>
        <ErrorAlert error={create.error} />
        <SelectField label="What is this about?" name="category" value={category} onChange={setCategory} options={CATEGORIES} error={create.error} />
        <TextField label="Subject" name="subject" required value={subject} onChange={setSubject} maxLength={160} error={create.error} />
        <TextArea label="Details" name="body" required value={body} onChange={setBody} maxLength={4000} error={create.error}
          hint="Please do not include passwords, full license numbers or other sensitive details. Support staff will tell you if they need more." />
        <button type="submit" className="btn" disabled={create.pending || !subject || !body}>{create.pending ? 'Sending…' : 'Send request'}</button>
      </form>
    </Card>
  );
}

function Support() {
  const [page, setPage] = useState(1);
  const list = useApi<{ tickets: T[]; total: number; pageSize: number }>('/support/tickets', { page });
  return (
    <>
      <PageHeader title="Support" subtitle="Questions, problems and disputes. Replies appear here and in your notifications." />
      <NewTicket onCreated={() => { setPage(1); void list.reload(); }} />
      <QueryBoundary state={list}>
        {(d) => (
          <>
            <DataTable caption="Your support requests" rows={d.tickets} rowKey={(t) => t.id}
              empty={<p className="muted">You have no support requests.</p>}
              columns={[
                { header: 'Subject', cell: (t) => <Link href={`/support/${t.id}`}>{t.subject}</Link> },
                { header: 'Topic', cell: (t) => titleCase(t.category) },
                { header: 'Status', cell: (t) => <Badge tone={t.status === 'pending_user' ? 'warning' : t.status === 'open' ? 'info' : 'neutral'}>{t.status === 'pending_user' ? 'Waiting for you' : titleCase(t.status)}</Badge> },
                { header: 'Updated', cell: (t) => formatDateTime(t.updated_at) },
              ]} />
            <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}

export default function SupportPage() {
  return <RequireAuth><Support /></RequireAuth>;
}
