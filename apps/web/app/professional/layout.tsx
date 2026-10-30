'use client';
import type { ReactNode } from 'react';
import { RequireAuth, SideNav } from '@bsm/ui';

const ITEMS = [
  { href: '/professional', label: 'Overview', exact: true }, { href: '/professional/profile', label: 'Profile & visibility' },
  { href: '/professional/history', label: 'Education & experience' }, { href: '/professional/credentials', label: 'Licenses & certifications' },
  { href: '/professional/availability', label: 'Availability & preferences' }, { href: '/professional/jobs', label: 'Find jobs' },
  { href: '/professional/applications', label: 'My applications' }, { href: '/professional/invitations', label: 'Invitations' },
];

export default function ProfessionalLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <div className="layout-2"><SideNav label="Professional area" items={ITEMS} /><div>{children}</div></div>
    </RequireAuth>
  );
}
