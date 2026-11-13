'use client';
import Link from 'next/link';
import { LoginForm } from '@bsm/ui';

export default function FacilityLoginPage() {
  return (
    <>
      <LoginForm title="Facility sign in" subtitle="Post jobs, review applicants and manage your team." afterLogin="/facility" registerHref="/register/facility" />
      <p className="small muted" style={{ textAlign: 'center' }}>Signing in as a professional? <Link href="/login/professional">Professional sign in</Link></p>
    </>
  );
}
