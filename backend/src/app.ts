import express from 'express';
import { originCheck, requireAuth } from './middleware/access.js';
import { errorHandler, notFound, requestId } from './middleware/http.js';
import { Metrics, requestLogger } from './middleware/observability.js';
import { cors, globalRateLimit, securityHeaders } from './middleware/security.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { adminBillingRoutes } from './modules/billing/routes.js';
import { adminExchangeRoutes } from './modules/exchange/routes.js';
import { adminLegalRoutes } from './modules/legal/routes.js';
import { adminReviewRoutes } from './modules/reviews/routes.js';
import { adminOperationsRoutes } from './modules/admin/operations.js';
import { adminSettingsRoutes } from './modules/admin/settings.js';
import { adminMatchRetentionRoutes } from './modules/matching/retention-routes.js';
import { adminCredentialRoutes, adminTaxonomyRoutes, taxonomyReadRoutes } from './modules/admin/credentials.js';
import { documentDownloadRoutes } from './modules/credentials/routes.js';
import { professionalRoutes } from './modules/professionals/routes.js';
import { acceptInvitationRoutes } from './modules/invitations/routes.js';
import { applyRoutes } from './modules/applications/routes.js';
import { jobSearchRoutes } from './modules/jobs/search.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { adminSupportRoutes, supportRoutes } from './modules/support/routes.js';
import type { AppDeps } from './shared/deps.js';
import { logger as defaultLogger } from './shared/logger.js';

export function createApp(deps: AppDeps) {
  const app = express();
  const metrics = new Metrics();
  const production = deps.config.nodeEnv === 'production';
  app.disable('x-powered-by');
  app.set('trust proxy', production ? 1 : false);
  app.use(requestId);
  app.use(requestLogger(deps.logger ?? defaultLogger, metrics));
  app.use(securityHeaders(production));
  app.use(cors(deps.config.allowedOrigins));
  app.use(globalRateLimit(deps.globalLimit?.max ?? 600, deps.globalLimit?.windowMs ?? 300_000, deps.now));
  app.use(express.json({ limit: '100kb' }));
  app.use(originCheck(deps.config.allowedOrigins));

  const auth = authRoutes(deps);
  const needAuth = requireAuth(auth.auth);

  const v1 = express.Router();
  v1.get('/health', (_req, res) => { res.json({ status: 'ok' }); }); // liveness: the process is up
  v1.get('/ready', async (_req, res) => { // readiness: dependencies answer
    try { await deps.db.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  v1.use('/auth', auth.router);
  v1.use('/organizations', organizationRoutes(deps, needAuth));
  v1.use('/invitations', acceptInvitationRoutes(deps, needAuth));
  v1.use('/professionals', professionalRoutes(deps, needAuth));
  v1.use('/jobs', applyRoutes(deps, needAuth));
  v1.use('/jobs', jobSearchRoutes(deps, needAuth));
  v1.use('/notifications', notificationRoutes(deps, needAuth));
  v1.use('/support', supportRoutes(deps, needAuth));
  v1.use('/credential-documents', documentDownloadRoutes(deps, needAuth));
  v1.use('/taxonomies', taxonomyReadRoutes(deps, needAuth));
  v1.use('/admin/taxonomies', adminTaxonomyRoutes(deps, needAuth));
  v1.use('/admin/settings', adminSettingsRoutes(deps, needAuth));
  v1.use('/admin/match-retention', adminMatchRetentionRoutes(deps, needAuth));
  v1.use('/admin/support', adminSupportRoutes(deps, needAuth));
  v1.use('/admin/billing', adminBillingRoutes(deps, needAuth));
  v1.use('/admin/reviews', adminReviewRoutes(deps, needAuth));
  v1.use('/admin/exchange', adminExchangeRoutes(deps, needAuth));
  v1.use('/admin/legal-signoffs', adminLegalRoutes(deps, needAuth));
  v1.use('/admin', adminCredentialRoutes(deps, needAuth));
  v1.use('/admin', adminRoutes(deps, needAuth)); // defines /users/lookup, which must precede /users/:id below
  v1.use('/admin', adminOperationsRoutes(deps, needAuth, metrics));
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
