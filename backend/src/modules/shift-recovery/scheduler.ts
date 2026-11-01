import type { CoreDeps } from '../../shared/deps.js';
import { logger } from '../../shared/logger.js';
import { runShiftRecovery } from './service.js';

/**
 * Runs recovery on a timer inside the API process. That is enough for one instance. With several instances, run this from
 * a single worker (see workers/README.md) so two passes do not race. A pass never overlaps the previous one.
 */
export function startShiftRecoveryScheduler(deps: Pick<CoreDeps, 'db' | 'email'>, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const sum = await runShiftRecovery(deps, { now: new Date() });
      if (sum.offersSent || sum.requestsSent || sum.escalated) logger.info(sum, 'shift recovery pass');
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.name : 'unknown' }, 'shift recovery pass failed');
    } finally { running = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
