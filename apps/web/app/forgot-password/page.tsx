'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Card, ErrorAlert, PageHeader, TextField, useAction, useClient } from '@bsm/ui';

export default function ForgotPasswordPage() {
  const client = useClient();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const submit = useAction(async () => { await client.post('/auth/password/forgot', { email }); setSent(true); });
  return (
    <div style={{ maxWidth: 480, margin: '32px auto' }}>
      <PageHeader title="Reset your password" />
      {sent ? <Alert tone="success" title="Check your email">If an account exists for that address, we have sent a reset link. It expires in one hour.</Alert> : (
        <Card>
          <form onSubmit={(e) => { e.preventDefault(); void submit.run(); }} noValidate>
            <ErrorAlert error={submit.error} />
            <TextField label="Email" name="email" type="email" autoComplete="email" required value={email} onChange={setEmail} error={submit.error} />
            <button type="submit" className="btn" disabled={submit.pending || !email}>{submit.pending ? 'Sending…' : 'Send reset link'}</button>
          </form>
        </Card>
      )}
      <p><Link href="/login">Back to sign in</Link></p>
    </div>
  );
}
