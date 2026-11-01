import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/index.js';

/** One id per process, so a server can tell its own lease from another server's. */
export const PROCESS_ID = randomUUID();

/**
 * Takes a named lease if nobody holds an unexpired one. It is a single atomic statement, so two servers cannot both win, and
 * it works through a connection pool (unlike session-level locks). The lease expires by itself, so a server that dies
 * mid-run does not block the job forever.
 */
export async function acquireLease(q: Queryable, name: string, holder: string, ttlMs: number, now: Date = new Date()): Promise<boolean> {
  const rows = await q.query<{ holder: string }>(
    `INSERT INTO scheduler_leases (name, holder, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at WHERE scheduler_leases.expires_at <= $4
     RETURNING holder`, [name, holder, new Date(now.getTime() + ttlMs), now]);
  return rows[0]?.holder === holder;
}

export async function releaseLease(q: Queryable, name: string, holder: string, now: Date = new Date()): Promise<void> {
  await q.query('UPDATE scheduler_leases SET expires_at = $3 WHERE name = $1 AND holder = $2', [name, holder, now]);
}

/** Runs `fn` only if the lease can be taken; returns null when someone else is already running it. */
export async function withLease<T>(q: Queryable, name: string, ttlMs: number, fn: () => Promise<T>, holder: string = `${PROCESS_ID}:${randomUUID()}`, now: Date = new Date()): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!(await acquireLease(q, name, holder, ttlMs, now))) return { ran: false };
  try { return { ran: true, value: await fn() }; }
  finally { await releaseLease(q, name, holder).catch(() => undefined); }
}
