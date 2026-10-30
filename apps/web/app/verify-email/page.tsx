'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Loading, PageHeader, useClient } from '@bsm/ui';

export default function VerifyEmailPage() {
  const client = useClient();
  const [state, setState] = useState<'working' | 'done' | 'failed' | 'missing'>('working');
  const [message, setMessage] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // React strict mode runs effects twice in development; the token is single use
    started.current = true;
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setState('missing'); return; }
    client.post('/auth/verify-email', { token }).then(() => setState('done')).catch((e) => { setMessage(e.message); setState('failed'); });
  }, [client]);
  return (
    <div style={{ maxWidth: 520, margin: '32px auto' }}>
      <PageHeader title="Confirm your email" />
      {state === 'working' && <Loading label="Confirming…" />}
      {state === 'done' && <Alert tone="success" title="Email confirmed">You can now <Link href="/login">sign in</Link>.</Alert>}
      {state === 'failed' && <Alert tone="error" title="This link did not work">{message} Links can be used once and expire after 24 hours. <Link href="/register">Register again</Link> or <Link href="/forgot-password">reset your password</Link>.</Alert>}
      {state === 'missing' && <Alert tone="error">This page needs the link from your verification email.</Alert>}
    </div>
  );
}
