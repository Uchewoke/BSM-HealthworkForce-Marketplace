'use client';
import { Card, MfaSetup, PageHeader, RequireAuth, LinkButton } from '@bsm/ui';

export default function MfaPage() {
  return (
    <RequireAuth>
      <div style={{ maxWidth: 560, margin: '24px auto' }}>
        <PageHeader title="Multi-factor authentication" subtitle="Required before you can use any admin tool." />
        <Card><MfaSetup /></Card>
        <p><LinkButton href="/" tone="secondary">Continue to the dashboard</LinkButton></p>
      </div>
    </RequireAuth>
  );
}
