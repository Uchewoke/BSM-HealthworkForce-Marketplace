'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Card, ErrorAlert, PageHeader, TextField, useAction, useClient } from '@bsm/ui';

export default function ResetPasswordPage() {
  const client = useClient();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const submit = useAction(async () => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    await client.post('/auth/password/reset', { token, password });
    setDone(true);
  });
  return (
    <div style={{ maxWidth: 480, margin: '32px auto' }}>
      <PageHeader title="Choose a new password" />
      {done ? <Alert tone="success" title="Password updated">All other sessions were signed out. <Link href="/login">Sign in</Link>.</Alert> : (
        <Card>
          <form onSubmit={(e) => { e.preventDefault(); void submit.run(); }} noValidate>
            <ErrorAlert error={submit.error} />
            <TextField label="New password" name="password" type="password" autoComplete="new-password" required value={password} onChange={setPassword} error={submit.error} hint="At least 12 characters." />
            <button type="submit" className="btn" disabled={submit.pending || password.length < 12}>{submit.pending ? 'Saving…' : 'Update password'}</button>
          </form>
        </Card>
      )}
    </div>
  );
}
