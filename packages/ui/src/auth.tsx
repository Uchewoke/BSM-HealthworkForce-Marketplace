'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Card, ErrorAlert, PageHeader, TextField } from './components';
import { hardNavigate, useAction, useClient, useSession } from './hooks';

/** Only same-site relative paths are honored for "?next=", so a crafted link cannot send people elsewhere. */
export function safeNextPath(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  return raw;
}

export function LoginForm({ title = 'Sign in', subtitle, afterLogin = '/dashboard', registerHref, forgotHref = '/forgot-password' }: {
  title?: string; subtitle?: string; afterLogin?: string; registerHref?: string; forgotHref?: string;
}) {
  const client = useClient();
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const login = useAction(async () => {
    await client.post('/auth/login', { email, password, totpCode: totp || undefined });
    await refresh();
    const next = new URLSearchParams(window.location.search).get('next');
    hardNavigate(safeNextPath(next, afterLogin));
  });
  const needTotp = !!login.error?.mfaRequired || totp.length > 0;
  return (
    <div style={{ maxWidth: 440, margin: '32px auto' }}>
      <PageHeader title={title} subtitle={subtitle} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void login.run(); }} noValidate>
          <ErrorAlert error={login.error && !login.error.mfaRequired ? login.error : null} />
          {login.error?.mfaRequired && <Alert tone="info">Enter the 6-digit code from your authenticator app.</Alert>}
          <TextField label="Email" name="email" type="email" autoComplete="email" required value={email} onChange={setEmail} />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={setPassword} />
          {needTotp && <TextField label="Authentication code" name="totpCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={totp} onChange={setTotp} hint="From your authenticator app." />}
          <div className="row between">
            <button type="submit" className="btn" disabled={login.pending || !email || !password} aria-busy={login.pending || undefined}>{login.pending ? 'Signing in…' : 'Sign in'}</button>
            <Link href={forgotHref}>Forgot your password?</Link>
          </div>
        </form>
        {registerHref && <p className="small muted">New here? <Link href={registerHref}>Create an account</Link></p>}
      </Card>
    </div>
  );
}

/** Enroll a TOTP authenticator: shows the secret once, then asks for a code to confirm. */
export function MfaSetup({ onDone }: { onDone?: () => void }) {
  const client = useClient();
  const { refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const start = useAction(async () => { setSetup(await client.post('/auth/mfa/setup')); });
  const confirm = useAction(async () => { await client.post('/auth/mfa/confirm', { code }); await refresh(); setDone(true); onDone?.(); });
  if (done) return <Alert tone="success" title="Multi-factor authentication is on">You will be asked for a code each time you sign in.</Alert>;
  return (
    <div className="stack">
      {!setup ? (
        <>
          <p>Multi-factor authentication adds a second step at sign-in using an authenticator app. It is required for BSM staff accounts.</p>
          <ErrorAlert error={start.error} />
          <Button pending={start.pending} onClick={() => void start.run()}>Set up authenticator</Button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void confirm.run(); }}>
          <p>Add this key to your authenticator app (choose “enter a setup key”), then enter the 6-digit code it shows.</p>
          <p><code aria-label="Setup key" style={{ fontSize: '1.1rem', wordBreak: 'break-all' }}>{setup.secret}</code></p>
          <p className="small muted">Keep this key private. It is shown only now.</p>
          <ErrorAlert error={confirm.error} />
          <TextField label="6-digit code" name="code" inputMode="numeric" maxLength={6} required value={code} onChange={setCode} />
          <button type="submit" className="btn" disabled={confirm.pending || code.length !== 6}>{confirm.pending ? 'Checking…' : 'Confirm and turn on'}</button>
        </form>
      )}
    </div>
  );
}
