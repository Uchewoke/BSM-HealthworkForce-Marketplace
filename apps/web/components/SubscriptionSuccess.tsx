'use client';
import { useEffect, useState } from 'react';
import { Alert, LinkButton, PageHeader, useClient } from '@bsm/ui';
import { useOrg } from '@/lib/org';

/**
 * Where the provider's checkout sends people back to. Arriving here proves nothing: the plan is switched on only when the server has
 * received the provider's own confirmation, so this page asks the server and waits.
 */
export function SubscriptionSuccess({ area }: { area: 'facility' | 'agency' }) {
  const { org } = useOrg();
  const client = useClient();
  const [status, setStatus] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (status === 'active' || status === 'trialing' || tries >= 20) return;
    const t = setTimeout(async () => {
      try { const r = await client.get<{ subscription: { status: string } | null }>(`/organizations/${org.id}/billing/subscription`); setStatus(r.subscription?.status ?? null); } catch { /* keep waiting */ }
      setTries((n) => n + 1);
    }, tries === 0 ? 0 : 3000);
    return () => clearTimeout(t);
  }, [tries, status, client, org.id]);
  const done = status === 'active' || status === 'trialing';
  return (
    <>
      <PageHeader title={done ? 'Subscription confirmed' : 'Confirming your payment'} />
      {done
        ? <Alert tone="success">Your plan is active.</Alert>
        : <Alert tone="info">{tries >= 20 ? 'We have not received confirmation from the payment provider yet. This can take a few minutes; check the subscription page shortly.' : 'Waiting for confirmation from the payment provider…'}</Alert>}
      <LinkButton href={`/${area}/${org.id}/subscription`}>Go to subscription</LinkButton>
    </>
  );
}
