import { beforeAll, describe, expect, it } from 'vitest';
import { RECOVERY_LEASE, runRecoveryUnderLease } from '../src/modules/shift-recovery/scheduler.js';
import { acquireLease, releaseLease, withLease } from '../src/shared/lease.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => { ctx = await makeTestApp(); });

describe('scheduler lease', () => {
  const t0 = new Date('2026-11-01T12:00:00Z');
  const later = (ms: number) => new Date(t0.getTime() + ms);

  it('lets only one holder run at a time, and lets the next take over when it expires or is released', async () => {
    expect(await acquireLease(ctx.db, 'job-a', 'server-1', 60_000, t0)).toBe(true);
    expect(await acquireLease(ctx.db, 'job-a', 'server-2', 60_000, later(1_000))).toBe(false); // still held
    expect(await acquireLease(ctx.db, 'job-b', 'server-2', 60_000, later(1_000))).toBe(true); // other jobs are independent
    expect(await acquireLease(ctx.db, 'job-a', 'server-2', 60_000, later(61_000))).toBe(true); // server-1 never released, but its lease ran out
    expect(await acquireLease(ctx.db, 'job-a', 'server-1', 60_000, later(62_000))).toBe(false);
    await releaseLease(ctx.db, 'job-a', 'server-1', later(63_000)); // the wrong holder cannot release it
    expect(await acquireLease(ctx.db, 'job-a', 'server-1', 60_000, later(64_000))).toBe(false);
    await releaseLease(ctx.db, 'job-a', 'server-2', later(65_000));
    expect(await acquireLease(ctx.db, 'job-a', 'server-1', 60_000, later(66_000))).toBe(true);
  });

  it('runs the work only when it holds the lease, and always lets go, even if the work fails', async () => {
    let ran = 0;
    const first = await withLease(ctx.db, 'job-c', 60_000, async () => { ran++; return 'done'; });
    expect(first).toEqual({ ran: true, value: 'done' });
    await expect(withLease(ctx.db, 'job-c', 60_000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withLease(ctx.db, 'job-c', 60_000, async () => { ran++; return 'again'; })).toEqual({ ran: true, value: 'again' }); // released after the failure
    await acquireLease(ctx.db, 'job-c', 'someone-else', 60_000);
    expect(await withLease(ctx.db, 'job-c', 60_000, async () => { ran++; return 'never'; })).toEqual({ ran: false });
    expect(ran).toBe(2);
  });

  it('skips a recovery pass while another server is running one', async () => {
    expect(await runRecoveryUnderLease(ctx.deps)).toEqual({ organizations: 0, shiftsChecked: 0, offersSent: 0, requestsSent: 0, escalated: 0 }); // nothing enabled, but it ran
    await acquireLease(ctx.db, RECOVERY_LEASE, 'another-server', 5 * 60_000);
    expect(await runRecoveryUnderLease(ctx.deps)).toBeNull();
    await releaseLease(ctx.db, RECOVERY_LEASE, 'another-server');
    expect(await runRecoveryUnderLease(ctx.deps)).not.toBeNull();
  });
});
