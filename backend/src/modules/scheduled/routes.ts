import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { runMatchRetention } from '../matching/retention.js';
import { runRecoveryUnderLease } from '../shift-recovery/scheduler.js';

/**
 * Routes an external scheduler calls in place of the in-process timers in server.ts, which cannot run where the API is a
 * serverless function (Vercel Schedules, see vercel.json). Each pass takes the same database lease as the timer, so a scheduler
 * and a long-running server can coexist, and running a pass twice is harmless. Access needs the shared secret in
 * `Authorization: Bearer …`; a signed-in session does not count. The same environment switches as the timers apply:
 * an interval of 0 means off.
 */
export function scheduledRoutes(deps: AppDeps) {
  const r = Router();
  const log = deps.logger ?? defaultLogger;

  const requireSecret: RequestHandler = (req, _res, next) => {
    const secret = deps.config.cronSecret;
    if (!secret) return next(new AppError('UNAVAILABLE', 'Scheduled routes are off: CRON_SECRET is not set.'));
    const expected = Buffer.from(`Bearer ${secret}`);
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return next(new AppError('UNAUTHENTICATED', 'Scheduler secret missing or wrong.'));
    next();
  };
  r.use(requireSecret);

  r.post('/shift-recovery', async (req, res, next) => {
    try {
      if (deps.config.shiftRecoveryIntervalMinutes <= 0) return void res.json({ status: 'disabled' });
      const summary = await runRecoveryUnderLease(deps, { now: new Date(deps.now?.() ?? Date.now()), requestId: req.requestId });
      if (summary) log.info({ requestId: req.requestId, ...summary }, 'shift recovery pass (scheduled)');
      res.json(summary ? { status: 'ran', summary } : { status: 'skipped', reason: 'another pass holds the lease' });
    } catch (e) { next(e); }
  });

  r.post('/match-retention', async (req, res, next) => {
    try {
      if (deps.config.matchRetentionIntervalHours <= 0) return void res.json({ status: 'disabled' });
      const summary = await runMatchRetention(deps.db, { mode: 'scheduled', requestId: req.requestId, now: new Date(deps.now?.() ?? Date.now()) });
      if (summary) log.info({ requestId: req.requestId, runsDeleted: summary.runsDeleted, resultsDeleted: summary.resultsDeleted, moreRemaining: summary.moreRemaining }, 'match retention pass (scheduled)');
      res.json(summary ? { status: 'ran', summary } : { status: 'skipped', reason: 'another pass holds the lease' });
    } catch (e) { next(e); }
  });

  return r;
}
