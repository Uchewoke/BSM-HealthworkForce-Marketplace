'use client';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Alert, OrgStatusBadge, QueryBoundary, RequireAuth, SideNav, useApi } from '@bsm/ui';
import { OrgProvider, type Org } from '@/lib/org';

function Inner({ orgId, children }: { orgId: string; children: ReactNode }) {
  const state = useApi<{ organization: Org }>(`/organizations/${orgId}`);
  const base = `/facility/${orgId}`;
  const items = [
    { href: base, label: 'Overview', exact: true }, { href: `${base}/settings`, label: 'Organization profile' }, { href: `${base}/locations`, label: 'Locations & departments' },
    { href: `${base}/team`, label: 'Team & invitations' }, { href: `${base}/jobs`, label: 'Jobs & shifts' }, { href: `${base}/applications`, label: 'Applications' }, { href: `${base}/talent`, label: 'Find professionals' },
  ];
  return (
    <QueryBoundary state={state}>
      {(d) => (
        <OrgProvider value={{ org: d.organization, reload: state.reload }}>
          <p className="muted" style={{ margin: '0 0 8px' }}><strong>{d.organization.name}</strong> <OrgStatusBadge status={d.organization.status} /></p>
          {d.organization.status !== 'approved' && d.organization.status !== 'draft' && d.organization.status !== 'needs_information' && (
            <Alert tone={d.organization.status === 'submitted' || d.organization.status === 'under_review' ? 'info' : 'warning'}>
              {d.organization.status === 'submitted' || d.organization.status === 'under_review' ? 'Your organization is being reviewed by BSM. Restricted features unlock once it is approved.' : `This organization is ${d.organization.status}. See the overview for details.`}
            </Alert>
          )}
          <div className="layout-2"><SideNav label="Organization" items={items} /><div>{children}</div></div>
        </OrgProvider>
      )}
    </QueryBoundary>
  );
}

export default function OrgLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  return <RequireAuth><Inner orgId={orgId}>{children}</Inner></RequireAuth>;
}
