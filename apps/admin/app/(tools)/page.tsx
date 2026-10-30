'use client';
import Link from 'next/link';
import { Badge, Card, PageHeader, QueryBoundary, titleCase, useApi, useSession } from '@bsm/ui';

type Counts = Record<string, number>;

function CountsCard({ title, counts, href, attention }: { title: string; counts?: Counts; href?: string; attention?: string[] }) {
  if (!counts) return null;
  const entries = Object.entries(counts);
  return (
    <Card title={title} actions={href ? <Link href={href}>Open</Link> : undefined}>
      {entries.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <div className="row">{entries.map(([k, n]) => <Badge key={k} tone={attention?.includes(k) && n > 0 ? 'warning' : 'neutral'}>{titleCase(k)}: {n}</Badge>)}</div>
      )}
    </Card>
  );
}

function Metrics() {
  const m = useApi<{ uptimeSeconds: number; requests: number; byStatusClass: Counts; errorRate: number; rateLimited: number; latency: Counts }>('/admin/metrics');
  if (m.error) return null; // only super admins can see this card
  return (
    <Card title="Service health (this server process)">
      <QueryBoundary state={m}>
        {(d) => (
          <div className="row">
            <Badge tone="info">Requests: {d.requests}</Badge><Badge tone={d.errorRate > 0.01 ? 'danger' : 'success'}>Server error rate: {(d.errorRate * 100).toFixed(2)}%</Badge>
            <Badge tone={d.rateLimited ? 'warning' : 'neutral'}>Rate limited: {d.rateLimited}</Badge><Badge>Up {Math.round(d.uptimeSeconds / 60)} min</Badge>
          </div>
        )}
      </QueryBoundary>
      <p className="small muted">Counts are per server process and reset on restart. Use your monitoring system for alerts.</p>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useSession();
  const d = useApi<{ role: string; organizations?: Counts; credentials?: Counts; jobs?: Counts; applicationsLast7Days?: number; supportTickets?: Counts; unassignedOpenTickets?: number; users?: { total: number; suspended: number } }>('/admin/dashboard');
  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Signed in as ${titleCase(user?.platformRole)}. You see the areas your role allows.`} />
      <QueryBoundary state={d}>
        {(x) => (
          <>
            <div className="grid">
              <CountsCard title="Facility reviews" counts={x.organizations} href="/organizations" attention={['submitted', 'needs_information']} />
              <CountsCard title="Credential reviews" counts={x.credentials} href="/credentials" attention={['submitted', 'pending_review']} />
              <CountsCard title="Jobs" counts={x.jobs} href="/jobs" />
              {x.applicationsLast7Days !== undefined && <Card title="Applications"><p style={{ fontSize: '2rem', margin: 0 }}>{x.applicationsLast7Days}</p><p className="muted small">in the last 7 days</p></Card>}
              <CountsCard title="Support requests" counts={x.supportTickets} href="/support" attention={['open']} />
              {x.unassignedOpenTickets !== undefined && <Card title="Unassigned open requests"><p style={{ fontSize: '2rem', margin: 0 }}>{x.unassignedOpenTickets}</p></Card>}
              {x.users && <Card title="Users" actions={<Link href="/users">Search</Link>}><p style={{ fontSize: '2rem', margin: 0 }}>{x.users.total}</p><p className="muted small">{x.users.suspended} suspended</p></Card>}
            </div>
            <Metrics />
          </>
        )}
      </QueryBoundary>
    </>
  );
}
