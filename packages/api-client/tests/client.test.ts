import { describe, expect, it } from 'vitest';
import { ApiError, createClient, titleCase, toQuery } from '../src';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  it('builds query strings without empty values', () => {
    expect(toQuery({ a: 'x y', b: '', c: undefined, d: null, e: 0, f: false })).toBe('?a=x+y&e=0&f=false');
    expect(toQuery({})).toBe('');
    expect(toQuery(undefined)).toBe('');
  });

  it('always sends credentials and JSON, and parses responses', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const c = createClient({ baseUrl: 'http://api.test/v1', fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return json(200, { ok: true }); }) as unknown as typeof fetch });
    expect(await c.post('/things', { a: 1 })).toEqual({ ok: true });
    expect(seen!.url).toBe('http://api.test/v1/things');
    expect(seen!.init.credentials).toBe('include');
    expect((seen!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(seen!.init.body).toBe('{"a":1}');
  });

  it('turns server errors into ApiError with code, request id and field errors', async () => {
    const c = createClient({ baseUrl: 'http://x', fetchImpl: (async () => json(422, { error: { code: 'VALIDATION_FAILED', message: 'Bad', requestId: 'rid-1', details: { fieldErrors: { email: ['Invalid'] } } } })) as unknown as typeof fetch });
    const err = await c.get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'VALIDATION_FAILED', requestId: 'rid-1', message: 'Bad' });
    expect(err.fieldErrors).toEqual({ email: ['Invalid'] });
  });

  it('recognizes unauthenticated and MFA-required responses', async () => {
    const c = createClient({ baseUrl: 'http://x', fetchImpl: (async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Code needed', details: { mfaRequired: true } } })) as unknown as typeof fetch });
    const err = await c.post('/auth/login').catch((e) => e);
    expect(err.isUnauthenticated).toBe(true);
    expect(err.mfaRequired).toBe(true);
  });

  it('handles 204, non-JSON error pages and network failures with friendly messages', async () => {
    expect(await createClient({ baseUrl: 'http://x', fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch }).delete('/x')).toBeUndefined();
    const html = await createClient({ baseUrl: 'http://x', fetchImpl: (async () => new Response('<html>Bad gateway</html>', { status: 502 })) as unknown as typeof fetch }).get('/x').catch((e) => e);
    expect(html).toMatchObject({ status: 502, code: 'ERROR' });
    expect(html.message).not.toContain('<html>');
    const down = await createClient({ baseUrl: 'http://x', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }).get('/x').catch((e) => e);
    expect(down).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(down.message).toMatch(/Could not reach the server/);
  });

  it('uploads raw files with their own content type and a safely encoded name', async () => {
    let init: RequestInit | undefined;
    const c = createClient({ baseUrl: 'http://x', fetchImpl: (async (_u: string, i: RequestInit) => { init = i; return json(201, { document: { id: 'd' } }); }) as unknown as typeof fetch });
    const file = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' });
    await c.upload('/docs', file, 'My License é.pdf');
    const h = init!.headers as Record<string, string>;
    expect(h['content-type']).toBe('application/pdf');
    expect(h['x-file-name']).toBe(encodeURIComponent('My License é.pdf'));
    expect(init!.body).toBe(file);
  });

  it('formats enums for display', () => {
    expect(titleCase('pending_verification')).toBe('Pending verification');
    expect(titleCase(null)).toBe('');
  });
});
