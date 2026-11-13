'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { EmptyState, LinkButton, Loading, RequireAuth, SideNav, useApi } from '@bsm/ui';

const ITEMS = [
  { href: '/professional', label: 'Overview', exact: true }, { href: '/professional/profile', label: 'Profile & visibility' },
  { href: '/professional/history', label: 'Education & experience' }, { href: '/professional/credentials', label: 'Licenses & certifications' },
  { href: '/professional/availability', label: 'Availability & preferences' }, { href: '/professional/jobs', label: 'Find jobs' },
  { href: '/professional/applications', label: 'My applications' }, { href: '/professional/timesheets', label: 'Timesheets' }, { href: '/professional/reviews', label: 'Reviews & reliability' }, { href: '/professional/invitations', label: 'Invitations' }, { href: '/professional/agencies', label: 'Staffing agencies' }, { href: '/professional/float-pool', label: 'Regional float pool' },
];

/** Every page in this area needs a professional profile, except the overview, which is where the profile gets created. */
function RequireProfile({ children }: { children: ReactNode }) {
  const onOverview = usePathname() === '/professional';
  const me = useApi<unknown>(onOverview ? null : '/professionals/me');
  if (onOverview) return <>{children}</>;
  if (me.loading && !me.data && !me.error) return <Loading label="Loading your profile…" />;
  if (me.error?.status === 404) {
    return (
      <EmptyState title="No professional profile yet" action={<LinkButton href="/professional">Create your profile</LinkButton>}>
        Create your profile first. Then you can fill in this section.
      </EmptyState>
    );
  }
  return <>{children}</>;
}

export default function ProfessionalLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth loginPath="/login/professional">
      <div className="layout-2"><SideNav label="Professional area" items={ITEMS} /><div><RequireProfile>{children}</RequireProfile></div></div>
    </RequireAuth>
  );
}
