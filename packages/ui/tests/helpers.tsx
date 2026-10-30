import { render } from '@testing-library/react';
import { createClient, type ApiClient } from '@bsm/api-client';
import type { ReactElement } from 'react';
import { AppProviders } from '../src';

export type Handler = (req: { method: string; path: string; body?: any }) => { status?: number; body?: unknown } | undefined;

/** A client whose "network" is a plain function, so UI tests never touch a real server. */
export function fakeClient(handler: Handler): ApiClient & { calls: { method: string; path: string; body?: any }[] } {
  const calls: { method: string; path: string; body?: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace('http://api.test', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method ?? 'GET', path, body });
    const out = handler({ method: init.method ?? 'GET', path, body }) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r1' } } };
    const status = out.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(out.body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return Object.assign(createClient({ baseUrl: 'http://api.test', fetchImpl }), { calls });
}

export const signedOut: Handler = ({ path }) => (path === '/auth/me' ? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.', requestId: 'r0' } } } : undefined);

export function renderWithApp(ui: ReactElement, client: ApiClient) {
  return render(<AppProviders client={client}>{ui}</AppProviders>);
}
