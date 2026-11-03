import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import {
  DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, eraseProfessionalMatchData, listHolds, listRetentionHistory, loadRetention,
  placeHolds, previewMatchRetention, releaseHold, retentionSchema, runMatchRetention, saveRetention,
} from './retention.js';

const cleanupBody = z.object({ dryRun: z.boolean().default(false) });
const holdBody = z.object({ runIds: z.array(z.uuid()).min(1).max(100), reason: z.string().trim().min(3).max(200).regex(/^[\w .,:#/\-]+$/, 'Use a matter or ticket reference, not personal details.') });
const holdParams = z.object({ runId: z.uuid() });
// Defaults to a dry run so the safe action is the one you get by omission.
const erasureBody = z.object({
  professionalId: z.uuid(), dryRun: z.boolean().default(true),
  reference: z.string().trim().min(3).max(100).regex(/^[\w .,:#/\-]+$/, 'Use a request or ticket reference, not personal details.').optional(),
});
const historyQuery = z.object({ kind: z.enum(['match_retention', 'professional_erasure']).optional() });

/**
 * Retention, legal holds and professional erasure for match data, mounted at /admin/match-retention. Super admin only
 * (`admin.settings_manage`, MFA required), the same permission that governs ranking weights. Never reachable by facility or
 * professional users.
 */
export function adminMatchRetentionRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  r.use(needAuth);
  const manage = requirePlatformPermission('admin.settings_manage');

  r.get('/settings', manage, async (_req, res) => {
    const { days, version } = await loadRetention(db);
    res.json({ days, version, defaultDays: DEFAULT_RETENTION_DAYS, minDays: MIN_RETENTION_DAYS, maxDays: MAX_RETENTION_DAYS });
  });

  r.put('/settings', manage, validate({ body: retentionSchema }), async (req, res) => {
    const version = await saveRetention(db, req.body.days, req.auth!.userId);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.match_retention_updated', targetType: 'platform_setting', targetId: 'match_retention', requestId: req.requestId, metadata: { days: req.body.days, version } });
    res.json({ days: req.body.days, version });
  });

  r.post('/cleanup', manage, validate({ body: cleanupBody }), async (req, res) => {
    const { dryRun } = req.body as z.infer<typeof cleanupBody>;
    if (dryRun) return void res.json({ dryRun: true, summary: await previewMatchRetention(db, { userId: req.auth!.userId, requestId: req.requestId, now: new Date(now()) }) });
    const summary = await runMatchRetention(db, { mode: 'manual', userId: req.auth!.userId, requestId: req.requestId, now: new Date(now()) });
    if (!summary) throw new AppError('CONFLICT', 'A cleanup is already running. Try again shortly.');
    res.json({ dryRun: false, summary });
  });

  r.get('/history', manage, validate({ query: historyQuery }), async (req, res) => {
    res.json({ history: await listRetentionHistory(db, (req.query as z.infer<typeof historyQuery>).kind) });
  });

  r.get('/holds', manage, async (_req, res) => { res.json({ holds: await listHolds(db) }); });

  r.put('/holds', manage, validate({ body: holdBody }), async (req, res) => {
    res.json(await placeHolds(db, { runIds: [...new Set(req.body.runIds as string[])], reason: req.body.reason, userId: req.auth!.userId, requestId: req.requestId }));
  });

  r.delete('/holds/:runId', manage, validate({ params: holdParams }), async (req, res) => {
    if (!(await releaseHold(db, { runId: param(req, 'runId'), userId: req.auth!.userId, requestId: req.requestId }))) throw new AppError('NOT_FOUND', 'Resource not found.');
    res.status(204).end();
  });

  r.post('/erasure', manage, validate({ body: erasureBody }), async (req, res) => {
    const b = req.body as z.infer<typeof erasureBody>;
    res.json({ summary: await eraseProfessionalMatchData(db, { ...b, userId: req.auth!.userId, requestId: req.requestId }) });
  });

  return r;
}
