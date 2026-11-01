'use client';
import type { ReactNode } from 'react';
import { platformRoleCan, type Permission } from '@bsm/permissions';
import { AppProviders, AppShell, useSession, type NavItem } from '@bsm/ui';
import { api } from '@/lib/api';

/** Navigation shows only the tools the signed-in staff role may use. The server enforces the same rules. */
const TOOLS: (NavItem & { permission?: Permission })[] = [
  { href: '/', label: 'Dashboard', exact: true },
  { href: '/organizations', label: 'Facility review', permission: 'admin.facility_review' },
  { href: '/credentials', label: 'Credential review', permission: 'admin.credential_review' },
  { href: '/jobs', label: 'Marketplace', permission: 'admin.marketplace_oversight' },
  { href: '/billing', label: 'Billing', permission: 'admin.billing_manage' },
  { href: '/exchange', label: 'Regional exchange', permission: 'admin.marketplace_oversight' },
  { href: '/reviews', label: 'Review disputes', permission: 'admin.support' },
  { href: '/users', label: 'Users', permission: 'admin.user_lookup' },
  { href: '/support', label: 'Support', permission: 'admin.support' },
  { href: '/audit', label: 'Audit log', permission: 'admin.audit_read' },
  { href: '/settings', label: 'Configuration', permission: 'admin.taxonomy_manage' },
];

function Shell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const role = user?.platformRole;
  const nav = role && user.mfaVerified ? TOOLS.filter((t) => !t.permission || platformRoleCan(role, t.permission)) : [];
  return <AppShell brand="BSM Admin" nav={nav}>{children}</AppShell>;
}

export function Providers({ children }: { children: ReactNode }) {
  return <AppProviders client={api}><Shell>{children}</Shell></AppProviders>;
}
