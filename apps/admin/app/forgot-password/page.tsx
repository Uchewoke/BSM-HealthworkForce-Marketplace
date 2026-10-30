'use client';
import { Alert, PageHeader } from '@bsm/ui';

export default function AdminForgotPage() {
  return (
    <div style={{ maxWidth: 520, margin: '32px auto' }}>
      <PageHeader title="Reset your password" />
      <Alert tone="info">Staff password resets are handled by a BSM administrator, who can also re-issue multi-factor authentication. Contact your administrator.</Alert>
    </div>
  );
}
