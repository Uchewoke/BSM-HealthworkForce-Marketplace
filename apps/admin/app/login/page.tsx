'use client';
import { Alert, LoginForm } from '@bsm/ui';

export default function AdminLoginPage() {
  return (
    <>
      <LoginForm title="BSM staff sign in" afterLogin="/" />
      <div style={{ maxWidth: 440, margin: '0 auto' }}>
        <Alert tone="info">Staff accounts require multi-factor authentication. If you have not enrolled yet, sign in and you will be taken through setup.</Alert>
      </div>
    </>
  );
}
