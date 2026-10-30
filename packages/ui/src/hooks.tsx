'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, toQuery, type ApiClient, type Query } from '@bsm/api-client';

const ClientContext = createContext<ApiClient | null>(null);

export function useClient(): ApiClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('useClient must be used inside <AppProviders>');
  return c;
}

export interface SessionUser { id: string; email: string; platformRole: string | null; mfaVerified: boolean }
interface SessionValue { user: SessionUser | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const SessionContext = createContext<SessionValue | null>(null);

/** Provides the API client and the signed-in user (from the server session) to the whole app. */
export function AppProviders({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setUser((await client.get<{ user: SessionUser }>('/auth/me')).user); }
    catch { setUser(null); }
    finally { setLoading(false); }
  }, [client]);
  const logout = useCallback(async () => {
    try { await client.post('/auth/logout'); } catch { /* the session may already be gone */ }
    setUser(null);
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  const value = useMemo(() => ({ user, loading, refresh, logout }), [user, loading, refresh, logout]);
  return <ClientContext.Provider value={client}><SessionContext.Provider value={value}>{children}</SessionContext.Provider></ClientContext.Provider>;
}

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used inside <AppProviders>');
  return s;
}

export interface ApiState<T> { data?: T; error?: ApiError; loading: boolean; reload: () => Promise<void> }

/** GET a path and track loading/error state. Pass `null` to skip (e.g. while waiting for an id). */
export function useApi<T = any>(path: string | null, query?: Query): ApiState<T> {
  const client = useClient();
  const key = path ? `${path}${toQuery(query)}` : null;
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: !!key });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) { setState({ loading: false }); return; }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const data = await client.get<T>(path, query);
      if (mine === seq.current) setState({ data, loading: false });
    } catch (e) {
      if (mine === seq.current) setState({ error: e as ApiError, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, reload: load };
}

/** Wraps a mutation: tracks pending state and the last error, never throws into the component. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true); setError(null);
    try { return await latest.current(...args); }
    catch (e) { setError(e as ApiError); return undefined; }
    finally { setPending(false); }
  }, []);
  return { run, pending, error, clearError: () => setError(null) };
}

/** First server-side validation message for a field, if any. */
export const fieldError = (error: ApiError | null | undefined, name: string): string | undefined => error?.fieldErrors?.[name]?.[0];
