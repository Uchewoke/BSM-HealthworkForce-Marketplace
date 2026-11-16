import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore, RateLimiter, UpstashRateLimitStore } from '../src/shared/rate-limit.js';

describe('rate limiter', () => {
  it('counts in a fixed window and resets after it', async () => {
    let t = 1_000_000;
    const limiter = new RateLimiter(2, 1000, () => t);
    expect(await limiter.allow('k')).toBe(true);
    expect(await limiter.allow('k')).toBe(true);
    expect(await limiter.allow('k')).toBe(false);
    expect(await limiter.allow('other')).toBe(true);
    t += 1001;
    expect(await limiter.allow('k')).toBe(true);
  });

  it('uses the shared store when one is given', async () => {
    const store = new MemoryRateLimitStore();
    const a = new RateLimiter(1, 60_000, () => 5, store);
    const b = new RateLimiter(1, 60_000, () => 5, store);
    expect(await a.allow('ip:1')).toBe(true);
    expect(await b.allow('ip:1')).toBe(false); // a second "instance" sees the first one's count
  });

  it('fails open when the store is unavailable', async () => {
    const limiter = new RateLimiter(1, 60_000, Date.now, { hit: async () => { throw new Error('redis down'); } });
    expect(await limiter.allow('k')).toBe(true);
    expect(await limiter.allow('k')).toBe(true);
  });

  it('sends one INCR + PEXPIRE pipeline per hit to Upstash and reads the count back', async () => {
    const calls: { url: string; body: unknown; auth: string | undefined }[] = [];
    let count = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.authorization });
      count += 1;
      return new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 });
    }) as typeof fetch;
    const store = new UpstashRateLimitStore('https://example.upstash.io/', 'tok', fetchFn);
    expect(await store.hit('login:1.2.3.4', 60_000, 120_000)).toBe(1);
    expect(await store.hit('login:1.2.3.4', 60_000, 120_000)).toBe(2);
    expect(calls[0]!.url).toBe('https://example.upstash.io/pipeline');
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(calls[0]!.body).toEqual([['INCR', 'rl:login:1.2.3.4:2'], ['PEXPIRE', 'rl:login:1.2.3.4:2', '60000', 'NX']]);
  });

  it('treats a bad reply from Upstash as an error (so the limiter fails open, not closed)', async () => {
    const fetchFn = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const store = new UpstashRateLimitStore('https://example.upstash.io', 'tok', fetchFn);
    await expect(store.hit('k', 1000, 0)).rejects.toThrow(/500/);
    const limiter = new RateLimiter(1, 1000, () => 0, store);
    expect(await limiter.allow('k')).toBe(true);
  });
});
