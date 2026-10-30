'use client';
import type { ReactNode } from 'react';
import { RequireAuth } from '@bsm/ui';

/** Every staff tool requires a platform role and a session that has passed multi-factor authentication. */
export default function ToolsLayout({ children }: { children: ReactNode }) {
  return <RequireAuth platform>{children}</RequireAuth>;
}
