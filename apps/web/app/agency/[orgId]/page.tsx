'use client';
import { Alert, Card, LinkButton, PageHeader, QueryBoundary, Timeline, titleCase, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

const GUIDE: Record<string, { tone: 'info' | 'warning' | 'success' | 'error'; text: string }> = {
  draft: { tone: 'info', text: 'Complete your agency profile and submit it for BSM review. You can invite professionals and submit candidates after it is approved.' },
  submitted: { tone: 'info', text: 'Submitted. A BSM reviewer will pick it up. You will be notified of the decision.' },
  under_review: { tone: 'info', text: 'A BSM reviewer is looking at your agency now.' },
  needs_information: { tone: 'warning', text: 'BSM needs more information. Read the message below, update your profile, and submit again.' },
  approved: { tone: 'success', text: 'Approved. Build your roster, then submit candidates for jobs that facilities have shared with you.' },
  rejected: { tone: 'error', text: 'This agency was not approved. See the reason below. Contact support if you believe this is a mistake.' },
  suspended: { tone: 'error', text: 'This agency is suspended. Restricted features are unavailable. See the reason below or contact support.' },
};

export default function AgencyOverview() {
  const { org, approved, can } = useOrg();
  const reviews = useApi<{ reviews: { id: string; actor_kind: string; from_status: string; to_status: string; reason: string | null; created_at: string }[] }>(`/organizations/${org.id}/reviews`);
  const roster = useApi<{ roster: { status: string }[] }>(can('agency.roster.read') ? `/organizations/${org.id}/agency/roster` : null);
  const jobs = useApi<{ jobs: unknown[] }>(approved && can('agency.jobs.read') ? `/organizations/${org.id}/agency/jobs` : null);
  const subs = useApi<{ total: number }>(approved && can('agency.submissions.read') ? `/organizations/${org.id}/agency/submissions` : null, { pageSize: 1 });
  const g = GUIDE[org.status] ?? GUIDE.draft!;
  const last = reviews.data?.reviews.filter((r) => r.actor_kind === 'platform').at(-1);
  return (
    <>
      <PageHeader title="Overview" />
      <Alert tone={g.tone}>{g.text}</Alert>
      {last?.reason && ['needs_information', 'rejected', 'suspended'].includes(org.status) && <Alert tone="warning" title="Message from BSM">{last.reason}</Alert>}
      {(org.status === 'draft' || org.status === 'needs_information') && <p><LinkButton href={`/agency/${org.id}/settings`}>Go to agency profile</LinkButton></p>}
      {approved && (
        <div className="grid">
          <Card title="Active roster"><p style={{ fontSize: '2rem', margin: 0 }}>{roster.data ? roster.data.roster.filter((r) => r.status === 'active').length : '…'}</p><LinkButton href={`/agency/${org.id}/roster`} tone="secondary">Manage roster</LinkButton></Card>
          <Card title="Jobs open to you"><p style={{ fontSize: '2rem', margin: 0 }}>{jobs.data?.jobs.length ?? '…'}</p><LinkButton href={`/agency/${org.id}/jobs`} tone="secondary">View jobs</LinkButton></Card>
          <Card title="Submissions"><p style={{ fontSize: '2rem', margin: 0 }}>{subs.data?.total ?? '…'}</p><LinkButton href={`/agency/${org.id}/submissions`} tone="secondary">Track</LinkButton></Card>
        </div>
      )}
      <Card title="Review history">
        <QueryBoundary state={reviews}>
          {(d) => d.reviews.length === 0 ? <p className="muted">No review activity yet.</p> : (
            <Timeline items={d.reviews.map((r) => ({ key: r.id, at: r.created_at, title: `${r.actor_kind === 'platform' ? 'BSM' : 'Your team'}: ${titleCase(r.from_status)} → ${titleCase(r.to_status)}`, detail: r.reason ?? undefined }))} />
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}
