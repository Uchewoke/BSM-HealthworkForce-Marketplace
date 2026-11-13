'use client';
import Link from 'next/link';
import { LoginForm } from '@bsm/ui';

export default function ProfessionalLoginPage() {
  return (
    <>
      <LoginForm title="Professional sign in" subtitle="Manage your profile, credentials, applications and timesheets." afterLogin="/professional" registerHref="/register/professional" />
      <p className="small muted" style={{ textAlign: 'center' }}>Signing in for a facility? <Link href="/login/facility">Facility sign in</Link></p>
    </>
  );
}
