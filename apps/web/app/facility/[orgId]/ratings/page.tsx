'use client';
import { Alert, Badge, Card, DataTable, EmptyState, PageHeader, QueryBoundary, formatDateTime, useApi } from '@bsm/ui';
import { RatingForm, RatingText, ReceivedList, WindowNote, type RatingSummary, type ReceivedReview } from '@/components/Reviews';
import { useOrg } from '@/lib/org';

interface Data {
  windowDays: number;
  toReview: { assignment_id: string; title: string; professional_name: string; starts_at: string; review_until: string }[];
  written: { id: string; rating: number; comment: string | null; created_at: string; professional_name: string }[];
  received: ReceivedReview[];
  rating: RatingSummary;
}

export default function RatingsPage() {
  const { org, can } = useOrg();
  const state = useApi<Data>(`/organizations/${org.id}/ratings`);
  return (
    <>
      <PageHeader title="Reviews" subtitle="Rate professionals after a completed shift, and see how professionals rated your organization." />
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <WindowNote days={d.windowDays} />
            <Card title="Your organization’s rating">
              <p><RatingText rating={d.rating} who={org.name} /></p>
              <p className="small muted">Professionals see your average once you have at least 3 reviews. Reviews from professionals are anonymous to you.</p>
            </Card>
            <Card title="Shifts you can review">
              {d.toReview.length === 0 ? <EmptyState title="Nothing to review right now">Once you approve a professional’s hours you can rate the shift here.</EmptyState> : !can('applications.manage') ? <Alert tone="info">Your role cannot write reviews.</Alert> : (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                  {d.toReview.map((t) => (
                    <li key={t.assignment_id}>
                      <Card title={`${t.professional_name} · ${t.title}`} actions={<Badge tone="info">Open until {formatDateTime(t.review_until)}</Badge>}>
                        <RatingForm path={`/organizations/${org.id}/assignments/${t.assignment_id}/review`} label={`Rate ${t.professional_name}`} onDone={state.reload} />
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Reviews about your organization">
              <ReceivedList reviews={d.received} canDispute={can('applications.manage')} reload={state.reload} disputePath={(id) => `/organizations/${org.id}/reviews/${id}/dispute`} />
            </Card>
            <Card title="Reviews you wrote">
              <DataTable caption="Reviews you wrote" rows={d.written} rowKey={(w) => w.id} empty={<p className="muted">You have not reviewed any professional yet.</p>}
                columns={[{ header: 'Professional', cell: (w) => w.professional_name }, { header: 'Rating', cell: (w) => `${w.rating} / 5` }, { header: 'Comment', cell: (w) => w.comment ?? '—' }, { header: 'When', cell: (w) => formatDateTime(w.created_at) }]} />
            </Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
