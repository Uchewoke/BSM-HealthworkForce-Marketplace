'use client';
import { Alert, Card, LinkButton, PageHeader, QueryBoundary, Timeline, titleCase, useApi } from '@bsm/ui';
import { useOrg } from '@/lib/org';

const GUIDE: Record<string, { tone: 'info' | 'warning' | 'success' | 'error'; text: string }> = {
  draft: { tone: 'info', text: 'Complete your organization profile and submit it for BSM review. You can post jobs after it is approved.' },
  submitted: { tone: 'info', text: 'Submitted. A BSM reviewer will pick it up. You will be notified of the decision.' },
  under_review: { tone: 'info', text: 'A BSM reviewer is looking at your organization now.' },
  needs_information: { tone: 'warning', text: 'BSM needs more information. Read the message below, update your profile, and submit again.' },
  approved: { tone: 'success', text: 'Approved. You can manage locations, post jobs and review applicants.' },
  rejected: { tone: 'error', text: 'This organization was not approved. See the reason below. Contact support if you believe this is a mistake.' },
  suspended: { tone: 'error', text: 'This organization is suspended. Restricted features are unavailable. See the reason below or contact support.' },
};

export default function OrgOverview() {
  const { org, approved } = useOrg();
  const reviews = useApi<{ reviews: { id: string; actor_kind: string; from_status: string; to_status: string; reason: string | null; created_at: string }[] }>(`/organizations/${org.id}/reviews`);
  const openJobs = useApi<{ total: number }>(approved ? `/organizations/${org.id}/jobs` : null, { status: 'published', pageSize: 1 });
  const newApps = useApi<{ total: number }>(approved ? `/organizations/${org.id}/applications` : null, { status: 'submitted', pageSize: 1 });
  const recovery = useApi<{ shifts: { status: string; escalated_at: string | null; open_positions: number }[] }>(approved ? `/organizations/${org.id}/shift-recovery` : null);
  const needAttention = recovery.data?.shifts.filter((x) => x.status === 'active' && x.escalated_at && x.open_positions > 0).length ?? 0;
  const g = GUIDE[org.status] ?? GUIDE.draft!;
  const last = reviews.data?.reviews.filter((r) => r.actor_kind === 'platform').at(-1);
  return (
    <>
      <PageHeader title="Overview" />
      <Alert tone={g.tone}>{g.text}</Alert>
      {last?.reason && ['needs_information', 'rejected', 'suspended'].includes(org.status) && <Alert tone="warning" title="Message from BSM">{last.reason}</Alert>}
      {needAttention > 0 && <Alert tone="warning" title={`${needAttention} shift${needAttention === 1 ? '' : 's'} still unfilled`}>Automatic outreach could not fill {needAttention === 1 ? 'it' : 'them'}. <a href={`/facility/${org.id}/recovery`}>See what happened and the suggested next steps</a>.</Alert>}
      {(org.status === 'draft' || org.status === 'needs_information') && <p><LinkButton href={`/facility/${org.id}/settings`}>Go to organization profile</LinkButton></p>}
      {approved && (
        <div className="grid">
          <Card title="Open jobs"><p style={{ fontSize: '2rem', margin: 0 }}>{openJobs.data?.total ?? '…'}</p><LinkButton href={`/facility/${org.id}/jobs`} tone="secondary">Manage jobs</LinkButton></Card>
          <Card title="New applications"><p style={{ fontSize: '2rem', margin: 0 }}>{newApps.data?.total ?? '…'}</p><LinkButton href={`/facility/${org.id}/applications`} tone="secondary">Review</LinkButton></Card>
          <Card title="Find professionals"><p>Search professionals who chose to be discoverable and invite them to apply.</p><LinkButton href={`/facility/${org.id}/talent`} tone="secondary">Search</LinkButton></Card>
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
