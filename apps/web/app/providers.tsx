'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppProviders, AppShell, useClient, useSession, type NavItem } from '@bsm/ui';
import { api } from '@/lib/api';

function Shell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const client = useClient();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!user) { setUnread(0); return; }
    client.get<{ unread: number }>('/notifications/unread-count').then((r) => setUnread(r.unread)).catch(() => setUnread(0));
  }, [user, client, pathname]);
  const nav: NavItem[] = user
    ? [{ href: '/dashboard', label: 'Dashboard' }, { href: '/notifications', label: 'Notifications' }, { href: '/support', label: 'Support' }, { href: '/account', label: 'Account' }]
    : [{ href: '/how-it-works', label: 'How it works' }];
  return <AppShell brand="BSM HealthForce" nav={nav} unreadCount={unread}>{children}</AppShell>;
}

export function Providers({ children }: { children: ReactNode }) {
  return <AppProviders client={api}><Shell>{children}</Shell></AppProviders>;
}
