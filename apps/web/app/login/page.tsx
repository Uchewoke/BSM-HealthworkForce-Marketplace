'use client';
import Link from 'next/link';
import { LoginForm } from '@bsm/ui';

export default function LoginPage() {
  return (
    <>
      <LoginForm subtitle="One account works as a professional, as a facility team member, or both." registerHref="/register" />
      <p className="small muted" style={{ textAlign: 'center' }}>
        <Link href="/login/professional">Professional sign in</Link> · <Link href="/login/facility">Facility sign in</Link>
      </p>
    </>
  );
}
