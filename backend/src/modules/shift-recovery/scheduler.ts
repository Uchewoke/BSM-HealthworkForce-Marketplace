import type { CoreDeps } from '../../shared/deps.js';
import { withLease } from '../../shared/lease.js';
import { logger } from '../../shared/logger.js';
import { runShiftRecovery, type RunSummary } from './service.js';

export const RECOVERY_LEASE = 'shift_recovery';
/** Longer than any normal pass; if a server dies mid-pass, another takes over after this. */
export const RECOVERY_LEASE_MS = 5 * 60_000;

/** One pass under the shared lease, so several API servers never run it at once. Returns null if another server is already running it. */
export async function runRecoveryUnderLease(deps: Pick<CoreDeps, 'db' | 'email'>, opts: { now?: Date; organizationId?: string; requestId?: string } = {}): Promise<RunSummary | null> {
  const now = opts.now ?? new Date();
  const res = await withLease(deps.db, RECOVERY_LEASE, RECOVERY_LEASE_MS, () => runShiftRecovery(deps, { now, organizationId: opts.organizationId, requestId: opts.requestId }), undefined, now);
  return res.ran ? res.value : null;
}

/** Runs recovery on a timer inside the API process. Safe with several API servers: the lease means only one runs each pass. */
export function startShiftRecoveryScheduler(deps: Pick<CoreDeps, 'db' | 'email'>, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const sum = await runRecoveryUnderLease(deps);
      if (sum && (sum.offersSent || sum.requestsSent || sum.escalated)) logger.info(sum, 'shift recovery pass');
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.name : 'unknown' }, 'shift recovery pass failed');
    } finally { running = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
