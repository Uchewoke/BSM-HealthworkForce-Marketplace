'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, CheckField, ErrorAlert, MfaSetup, PageHeader, QueryBoundary, RequireAuth, useAction, useApi, useClient, useSession } from '@bsm/ui';

const CATEGORY_LABELS: Record<string, string> = {
  application_updates: 'Applications, offers and invitations',
  review_decisions: 'Review decisions about my organization, credentials or listings',
  support_updates: 'Replies to my support requests',
  billing_updates: 'Invoices and payments',
};

function Preferences() {
  const client = useClient();
  const state = useApi<{ preferences: { category: string; emailEnabled: boolean }[] }>('/notifications/preferences');
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (state.data) setPrefs(Object.fromEntries(state.data.preferences.map((p) => [p.category, p.emailEnabled]))); }, [state.data]);
  const save = useAction(async () => {
    await client.put('/notifications/preferences', { preferences: Object.entries(prefs).map(([category, emailEnabled]) => ({ category, emailEnabled })) });
    setSaved(true);
  });
  return (
    <Card title="Email notifications">
      <p className="muted">You always see notifications in the app. Choose which ones are also emailed. Emails contain only a short headline, never personal or credential details.</p>
      <QueryBoundary state={state}>
        {() => (
          <form onSubmit={(e) => { e.preventDefault(); setSaved(false); void save.run(); }}>
            <ErrorAlert error={save.error} />
            {saved && <Alert tone="success">Preferences saved.</Alert>}
            {Object.entries(prefs).map(([c, v]) => <CheckField key={c} label={CATEGORY_LABELS[c] ?? c} checked={v} onChange={(x) => { setSaved(false); setPrefs({ ...prefs, [c]: x }); }} />)}
            <Button type="submit" pending={save.pending}>Save preferences</Button>
          </form>
        )}
      </QueryBoundary>
    </Card>
  );
}

function Account() {
  const { user } = useSession();
  const [showMfa, setShowMfa] = useState(false);
  return (
    <>
      <PageHeader title="Account" subtitle={user?.email} />
      <Card title="Security">
        <p>Password changes use the “Forgot your password?” link on the sign-in page. Signing out of one device does not sign you out of others; resetting your password signs out every device.</p>
        <p>Multi-factor authentication is optional for most accounts and required for BSM staff.</p>
        {showMfa ? <MfaSetup /> : <Button tone="secondary" onClick={() => setShowMfa(true)}>Set up multi-factor authentication</Button>}
      </Card>
      <Preferences />
    </>
  );
}

export default function AccountPage() {
  return <RequireAuth><Account /></RequireAuth>;
}
