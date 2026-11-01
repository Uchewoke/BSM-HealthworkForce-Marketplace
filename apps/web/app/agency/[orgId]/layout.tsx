'use client';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Alert, OrgStatusBadge, QueryBoundary, RequireAuth, SideNav, useApi } from '@bsm/ui';
import { OrgProvider, type Org } from '@/lib/org';

function Inner({ orgId, children }: { orgId: string; children: ReactNode }) {
  const state = useApi<{ organization: Org }>(`/organizations/${orgId}`);
  const base = `/agency/${orgId}`;
  const items = [
    { href: base, label: 'Overview', exact: true }, { href: `${base}/settings`, label: 'Agency profile' }, { href: `${base}/team`, label: 'Team & invitations' },
    { href: `${base}/roster`, label: 'Roster' }, { href: `${base}/jobs`, label: 'Open jobs' }, { href: `${base}/submissions`, label: 'Submissions' }, { href: `${base}/placements`, label: 'Placements' }, { href: `${base}/analytics`, label: 'Analytics' }, { href: `${base}/assistant`, label: 'Assistant' },
  ];
  return (
    <QueryBoundary state={state}>
      {(d) => (
        <OrgProvider value={{ org: d.organization, reload: state.reload }}>
          {d.organization.type !== 'agency' ? <Alert tone="warning">This is not a staffing agency. Open it from the facility area instead.</Alert> : (
            <>
              <p className="muted" style={{ margin: '0 0 8px' }}><strong>{d.organization.name}</strong> <OrgStatusBadge status={d.organization.status} /></p>
              {!['approved', 'draft', 'needs_information'].includes(d.organization.status) && (
                <Alert tone={d.organization.status === 'submitted' || d.organization.status === 'under_review' ? 'info' : 'warning'}>
                  {d.organization.status === 'submitted' || d.organization.status === 'under_review' ? 'Your agency is being reviewed by BSM. Inviting professionals and submitting candidates unlock once it is approved.' : `This agency is ${d.organization.status}. See the overview for details.`}
                </Alert>
              )}
              <div className="layout-2"><SideNav label="Agency" items={items} /><div>{children}</div></div>
            </>
          )}
        </OrgProvider>
      )}
    </QueryBoundary>
  );
}

export default function AgencyLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  return <RequireAuth><Inner orgId={orgId}>{children}</Inner></RequireAuth>;
}
