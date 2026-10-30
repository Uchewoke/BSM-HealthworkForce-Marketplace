/** Thin, typed fetch wrapper for the BSM backend. Browser code never talks to the database or holds secrets. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: any,
  ) { super(message); this.name = 'ApiError'; }

  /** Per-field validation messages from the server, keyed by field name. */
  get fieldErrors(): Record<string, string[]> {
    const fe = this.details?.fieldErrors;
    return fe && typeof fe === 'object' ? fe : {};
  }
  get isUnauthenticated() { return this.status === 401; }
  get mfaRequired() { return !!this.details?.mfaRequired; }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function toQuery(params?: Query): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface ClientOptions { baseUrl: string; fetchImpl?: typeof fetch }

export function createClient({ baseUrl, fetchImpl }: ClientOptions) {
  const doFetch = (...a: Parameters<typeof fetch>) => (fetchImpl ?? fetch)(...a);

  async function request<T = any>(method: string, path: string, init: { body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...init.headers };
    let body = init.body;
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, { method, headers, body, credentials: 'include' });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error pages */ }
    if (!res.ok) {
      const e = data?.error;
      throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status}).`, e?.requestId, e?.details);
    }
    return data as T;
  }

  return {
    baseUrl,
    get: <T = any>(path: string, query?: Query) => request<T>('GET', `${path}${toQuery(query)}`),
    post: <T = any>(path: string, json?: unknown) => request<T>('POST', path, { json: json ?? {} }),
    put: <T = any>(path: string, json?: unknown) => request<T>('PUT', path, { json: json ?? {} }),
    patch: <T = any>(path: string, json?: unknown) => request<T>('PATCH', path, { json: json ?? {} }),
    delete: <T = any>(path: string) => request<T>('DELETE', path),
    /** Raw-body upload used for credential documents (PDF/JPEG/PNG). */
    upload: <T = any>(path: string, file: Blob, fileName: string) =>
      request<T>('POST', path, { body: file, headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(fileName) } }),
  };
}

export type ApiClient = ReturnType<typeof createClient>;

/** Human-readable text for common server enums. */
export const titleCase = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
