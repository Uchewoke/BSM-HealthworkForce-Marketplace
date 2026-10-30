import { Router, type RequestHandler } from 'express';
import { requirePlatformPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { audit } from '../audit/service.js';
import { loadWeights, weightsSchema } from '../matching/loader.js';
import { DEFAULT_WEIGHTS, RANKING_VERSION } from '../matching/ranking.js';

/** Ranking configuration, mounted at /admin/settings. Weights only affect ordering among eligible candidates. */
export function adminSettingsRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const manage = requirePlatformPermission('admin.settings_manage');

  r.get('/ranking-weights', manage, async (_req, res) => {
    const { weights, version } = await loadWeights(db);
    res.json({ weights, version, defaults: DEFAULT_WEIGHTS, rankingVersion: RANKING_VERSION });
  });

  r.put('/ranking-weights', manage, validate({ body: weightsSchema }), async (req, res) => {
    const [row] = await db.query<{ version: number }>(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ('ranking_weights', $1::jsonb, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = platform_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING version`, [JSON.stringify(req.body), req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.ranking_weights_updated', targetType: 'platform_setting', targetId: 'ranking_weights', requestId: req.requestId, metadata: { version: row!.version, weights: req.body } });
    res.json({ weights: req.body, version: row!.version });
  });

  return r;
}
