'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, PageHeader, Pagination, QueryBoundary, SelectField, TextField, formatDateTime, titleCase, useAction, useApi, useClient } from '@bsm/ui';

interface Dispute {
  id: string; status: string; reason: string; created_at: string; resolution_note: string | null; resolved_at: string | null;
  review_id: string; direction: string; rating: number; comment: string | null; organization_name: string; professional_name: string;
}

function Resolve({ d, reload }: { d: Dispute; reload: () => Promise<void> }) {
  const client = useClient();
  const [note, setNote] = useState('');
  const act = useAction(async (outcome: 'uphold' | 'remove') => { await client.post(`/admin/reviews/disputes/${d.id}/resolve`, { outcome, note }); setNote(''); await reload(); });
  return (
    <>
      <ErrorAlert error={act.error} />
      <TextField label="Decision note (shown to the person who raised the dispute)" name="note" required value={note} onChange={setNote} maxLength={1500} error={act.error} />
      <div className="row">
        <Button tone="secondary" pending={act.pending} disabled={note.trim().length < 3} onClick={() => void act.run('uphold')}>Let the review stand</Button>
        <Button pending={act.pending} disabled={note.trim().length < 3} onClick={() => void act.run('remove')}>Remove the review</Button>
      </div>
    </>
  );
}

export default function ReviewDisputesPage() {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const list = useApi<{ disputes: Dispute[]; total: number; pageSize: number }>('/admin/reviews/disputes', { status, page });
  return (
    <>
      <PageHeader title="Review disputes" subtitle="A review can be left standing or removed. Staff never edit what someone wrote." />
      <Alert tone="info">Remove a review only if it breaks the rules (for example abuse, personal data, or claims about a shift it was not written for). Disagreement with the rating alone is not a reason.</Alert>
      <SelectField label="Status" name="status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['open', 'upheld', 'removed'].map((s) => ({ value: s, label: titleCase(s) }))} />
      <QueryBoundary state={list}>
        {(d) => d.disputes.length === 0 ? <EmptyState title={`No ${status} disputes`} /> : (
          <>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {d.disputes.map((x) => (
                <li key={x.id}>
                  <Card title={`${x.direction === 'facility_to_professional' ? `${x.organization_name} rated ${x.professional_name}` : `${x.professional_name} rated ${x.organization_name}`}: ${x.rating} / 5`} actions={<Badge tone={x.status === 'open' ? 'warning' : 'neutral'}>{titleCase(x.status)}</Badge>}>
                    <p><strong>Review:</strong> {x.comment ?? <span className="muted">No comment.</span>}</p>
                    <p><strong>Why it was disputed ({formatDateTime(x.created_at)}):</strong> {x.reason}</p>
                    {x.status === 'open' ? <Resolve d={x} reload={list.reload} /> : <p className="muted">Decision: {x.resolution_note} ({formatDateTime(x.resolved_at)})</p>}
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
