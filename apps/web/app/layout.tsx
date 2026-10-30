import '@bsm/ui/styles.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'BSM HealthForce Marketplace', template: '%s · BSM HealthForce' },
  description: 'A technology marketplace connecting healthcare facilities with independent healthcare professionals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
