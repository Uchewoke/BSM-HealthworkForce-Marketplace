'use client';
import { Badge, Card, EmptyState, LinkButton, Loading, OrgStatusBadge, PageHeader, RequireAuth, useApi } from '@bsm/ui';

interface Org { id: string; name: string; type: string; status: string; role: string }

function Dashboard() {
  const orgs = useApi<{ organizations: Org[] }>('/organizations');
  const pro = useApi<{ completeness: { percent: number; missing: string[] }; credentialSummary: Record<string, number> }>('/professionals/me');
  const hasProfile = !pro.error;
  return (
    <>
      <PageHeader title="Your dashboard" subtitle="Use one account as a professional, as a facility team member, or both." />
      <div className="grid">
        <Card title="As a healthcare professional">
          {pro.loading && !pro.data ? <Loading /> : hasProfile && pro.data ? (
            <>
              <p>Profile sections completed: <strong>{pro.data.completeness.percent}%</strong>. Completing your profile is not the same as having your credentials verified.</p>
              <div className="row">
                {Object.entries(pro.data.credentialSummary).map(([k, n]) => <Badge key={k} tone={k === 'verified' ? 'success' : k === 'expired' ? 'danger' : 'info'}>{n} {k.replace(/_/g, ' ')}</Badge>)}
              </div>
              <p><LinkButton href="/professional">Open professional area</LinkButton></p>
            </>
          ) : pro.error?.status === 404 ? (
            <EmptyState title="No professional profile yet" action={<LinkButton href="/professional">Create your profile</LinkButton>}>Create one to add credentials, search jobs and apply.</EmptyState>
          ) : <Loading />}
        </Card>
        <Card title="As a facility or agency team member">
          {orgs.loading && !orgs.data ? <Loading /> : orgs.data && orgs.data.organizations.length > 0 ? (
            <ul style={{ paddingLeft: 18 }}>
              {orgs.data.organizations.map((o) => (
                <li key={o.id}><a href={`/${o.type === 'agency' ? 'agency' : 'facility'}/${o.id}`}>{o.name}</a> <OrgStatusBadge status={o.status} /> <span className="muted small">({o.role.replace(/_/g, ' ')})</span></li>
              ))}
            </ul>
          ) : <EmptyState title="No organizations yet" action={<><LinkButton href="/facility">Register a facility</LinkButton> <LinkButton href="/agency" tone="secondary">Register an agency</LinkButton></>}>Register your organization, or accept an invitation from your team.</EmptyState>}
        </Card>
      </div>
    </>
  );
}

export default function DashboardPage() {
  return <RequireAuth><Dashboard /></RequireAuth>;
}
