'use client';
import { Alert, Badge, Card, DataTable, DefinitionList, EmptyState, PageHeader, QueryBoundary, formatDateTime, useApi } from '@bsm/ui';
import { RatingForm, RatingText, ReceivedList, WindowNote, type RatingSummary, type ReceivedReview } from '@/components/Reviews';

interface Data {
  windowDays: number;
  toReview: { assignment_id: string; title: string; organization_name: string; starts_at: string; review_until: string }[];
  written: { id: string; rating: number; comment: string | null; created_at: string; organization_name: string }[];
  received: ReceivedReview[];
  rating: RatingSummary;
  reliability: { completedShifts: number; noShows: number; cancellations: number; lateCancellations: number; completionRate: number | null; sampleSize: number };
}

export default function ReviewsPage() {
  const state = useApi<Data>('/professionals/me/reviews');
  return (
    <>
      <PageHeader title="Reviews & reliability" subtitle="Feedback from shifts you have worked, and the record facilities see." />
      <QueryBoundary state={state}>
        {(d) => (
          <>
            <WindowNote days={d.windowDays} />
            <Card title="Your reliability record">
              <p className="muted">Counted from what actually happened to your assignments. Facilities reviewing your application can see these figures as context. They are never used to decide whether you meet a job’s requirements.</p>
              <DefinitionList items={[
                ['Completed shifts', d.reliability.completedShifts], ['No-shows', d.reliability.noShows], ['Cancellations by you', `${d.reliability.cancellations} (${d.reliability.lateCancellations} within 48 hours of the start)`],
                ['Completion rate', d.reliability.completionRate === null ? 'No shifts yet' : `${d.reliability.completionRate}%`],
                ['Your average rating', <RatingText key="r" rating={d.rating} who="You" />],
              ]} />
              <p className="small muted">Others see your average only once you have at least 3 reviews. You always see your own.</p>
            </Card>
            <Card title="Shifts you can review">
              {d.toReview.length === 0 ? <EmptyState title="Nothing to review right now">After a facility approves your hours you can rate the experience here.</EmptyState> : (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                  {d.toReview.map((t) => (
                    <li key={t.assignment_id}>
                      <Card title={`${t.title} · ${t.organization_name}`} actions={<Badge tone="info">Open until {formatDateTime(t.review_until)}</Badge>}>
                        <RatingForm path={`/professionals/me/assignments/${t.assignment_id}/review`} label={`Rate ${t.organization_name}`} onDone={state.reload} />
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Reviews about you">
              <ReceivedList reviews={d.received} canDispute reload={state.reload} disputePath={(id) => `/professionals/me/reviews/${id}/dispute`} />
            </Card>
            <Card title="Reviews you wrote">
              <DataTable caption="Reviews you wrote" rows={d.written} rowKey={(w) => w.id} empty={<p className="muted">You have not reviewed any facility yet.</p>}
                columns={[{ header: 'Facility', cell: (w) => w.organization_name }, { header: 'Rating', cell: (w) => `${w.rating} / 5` }, { header: 'Comment', cell: (w) => w.comment ?? '—' }, { header: 'When', cell: (w) => formatDateTime(w.created_at) }]} />
            </Card>
            <Alert tone="info">If you believe a review is unfair or breaks the rules, use “Dispute this review”. BSM staff either let it stand or remove it; they do not edit reviews.</Alert>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
