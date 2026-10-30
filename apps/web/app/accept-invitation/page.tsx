'use client';
import { useState } from 'react';
import { Alert, Card, ErrorAlert, LinkButton, PageHeader, RequireAuth, useAction, useClient } from '@bsm/ui';

function Accept() {
  const client = useClient();
  const [joined, setJoined] = useState<{ organizationId: string; role: string } | null>(null);
  const accept = useAction(async () => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    setJoined(await client.post('/invitations/accept', { token }));
  });
  return (
    <div style={{ maxWidth: 520, margin: '32px auto' }}>
      <PageHeader title="Join an organization" />
      {joined ? (
        <Alert tone="success" title="You have joined">Your role is {joined.role.replace(/_/g, ' ')}. <LinkButton href={`/facility/${joined.organizationId}`}>Open the organization</LinkButton></Alert>
      ) : (
        <Card>
          <p>Accept the invitation sent to the email address of the account you are signed in with.</p>
          <ErrorAlert error={accept.error} />
          <button className="btn" onClick={() => void accept.run()} disabled={accept.pending}>{accept.pending ? 'Joining…' : 'Accept invitation'}</button>
        </Card>
      )}
    </div>
  );
}

export default function AcceptInvitationPage() {
  return <RequireAuth><Accept /></RequireAuth>;
}
