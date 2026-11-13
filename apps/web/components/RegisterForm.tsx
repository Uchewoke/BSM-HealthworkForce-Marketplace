'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Card, ErrorAlert, PageHeader, TextField, useAction, useClient } from '@bsm/ui';

/** Where each entry point sends people: its own sign-in page, and its own first screen after signing in. */
export const AUDIENCES = {
  professional: { title: 'Create your professional account', subtitle: 'For nurses, therapists and other independent healthcare professionals. You will build your profile and add credentials after you sign in.', loginHref: '/login/professional' },
  facility: { title: 'Register your facility', subtitle: 'For hospitals, clinics and other facilities. After you sign in, you will create your organization and submit it for BSM review.', loginHref: '/login/facility' },
  any: { title: 'Create your account', subtitle: 'You can use the same account as a professional and as a member of a facility.', loginHref: '/login' },
} as const;

export function RegisterForm({ audience = 'any' }: { audience?: keyof typeof AUDIENCES }) {
  const a = AUDIENCES[audience];
  const client = useClient();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const register = useAction(async () => { await client.post('/auth/register', { fullName, email, password }); setSent(true); });

  if (sent) {
    return (
      <div style={{ maxWidth: 520, margin: '32px auto' }}>
        <Alert tone="success" title="Check your email">If this address can be registered, we have sent a verification link. You can sign in after you confirm it.</Alert>
        <p><Link href={a.loginHref}>Go to sign in</Link></p>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 480, margin: '32px auto' }}>
      <PageHeader title={a.title} subtitle={a.subtitle} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void register.run(); }} noValidate>
          <ErrorAlert error={register.error} />
          <TextField label="Full name" name="fullName" autoComplete="name" required value={fullName} onChange={setFullName} error={register.error} />
          <TextField label="Email" name="email" type="email" autoComplete="email" required value={email} onChange={setEmail} error={register.error} />
          <TextField label="Password" name="password" type="password" autoComplete="new-password" required value={password} onChange={setPassword} error={register.error}
            hint="At least 12 characters. A passphrase of several words works well." />
          <button type="submit" className="btn" disabled={register.pending}>{register.pending ? 'Creating…' : 'Create account'}</button>
        </form>
        <p className="small muted">Already registered? <Link href={a.loginHref}>Sign in</Link></p>
      </Card>
      {audience === 'any' && (
        <p className="small muted" style={{ textAlign: 'center' }}>
          <Link href="/register/professional">I am a professional</Link> · <Link href="/register/facility">I represent a facility</Link>
        </p>
      )}
    </div>
  );
}
