import { logger } from './logger.js';

/**
 * Where fixed-window counters live. The in-memory store is per process and only fit for one long-running server or tests.
 * Serverless (Vercel) runs many instances, each with its own memory, so production needs a shared store: see UpstashRateLimitStore.
 */
export interface RateLimitStore {
  /** Increments the counter for `key` in the window that contains `now` and returns the new count. */
  hit(key: string, windowMs: number, now: number): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  async hit(key: string, windowMs: number, now: number): Promise<number> {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }
}

/**
 * Shared counters in Upstash Redis through its REST API (works from serverless functions; no persistent connection). Each window
 * is its own key (`<key>:<window number>`) that expires on its own, so a request never has to read before it writes.
 * Configure with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Any Redis behind a compatible REST proxy also works.
 */
export class UpstashRateLimitStore implements RateLimitStore {
  private readonly url: string;
  constructor(url: string, private readonly token: string, private readonly fetchFn: typeof fetch = fetch, private readonly timeoutMs = 1500) {
    this.url = url.replace(/\/+$/, '');
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitStore | undefined {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return undefined;
    return new UpstashRateLimitStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }

  async hit(key: string, windowMs: number, now: number): Promise<number> {
    const windowKey = `rl:${key}:${Math.floor(now / windowMs)}`;
    const res = await this.fetchFn(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([['INCR', windowKey], ['PEXPIRE', windowKey, String(windowMs), 'NX']]),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`rate-limit store answered ${res.status}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    const first = out[0];
    if (!first || first.error !== undefined || typeof first.result !== 'number') throw new Error('rate-limit store returned an unexpected reply');
    return first.result;
  }
}

/**
 * Fixed-window limiter. Without a store it counts in memory (per process). With a store the count is shared by every instance.
 * A store failure is logged and the request is allowed (fail open): an outage of the counter store must not take the API down,
 * and account lockout, which is the control that matters most, lives in the database and does not depend on this.
 */
export class RateLimiter {
  private readonly store: RateLimitStore;
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now, store?: RateLimitStore) {
    this.store = store ?? new MemoryRateLimitStore();
  }

  /** Resolves false when the key has exceeded its allowance. */
  async allow(key: string): Promise<boolean> {
    try {
      return (await this.store.hit(key, this.windowMs, this.now())) <= this.max;
    } catch (e) {
      logger.error({ err: { message: (e as Error)?.message } }, 'rate-limit store unavailable; allowing request');
      return true;
    }
  }
}
