import { Router } from 'express';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { createMatchRun, listMatchRuns, readMatchRun } from './service.js';

const jobParams = z.object({ orgId: z.uuid(), jobId: z.uuid() });
const runParams = z.object({ orgId: z.uuid(), runId: z.uuid() });
const createBody = z.object({
  scope: z.enum(['applicants', 'talent', 'both']).default('applicants'),
  shiftIds: z.array(z.uuid()).max(20).default([]),
});
const readQuery = z.object({
  group: z.enum(['eligible', 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Advisory candidate matching for a job, mounted at /organizations/:orgId. Creating a run needs the same permission and an
 * approved organization as talent search; reading needs `applications.read`. Nothing here changes an application: people act
 * through the existing invitation, review, offer and acceptance endpoints, which re-check eligibility.
 */
export function matchRunRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(20, 3600_000, now);
  const r = Router({ mergeParams: true });
  const create = [requireOrgPermission(deps, 'professionals.search'), requireApprovedOrg(deps)];
  const read = requireOrgPermission(deps, 'applications.read');

  r.post('/jobs/:jobId/match-runs', validate({ params: jobParams, body: createBody }), ...create, async (req, res) => {
    if (!limiter.allow(`match-run:${req.auth!.userId}`)) throw new AppError('RATE_LIMITED', 'Too many matching runs. Try again later.');
    const b = req.body as z.infer<typeof createBody>;
    const out = await createMatchRun(db, {
      organizationId: req.membership!.organizationId, jobId: param(req, 'jobId'), scope: b.scope, shiftIds: b.shiftIds,
      userId: req.auth!.userId, requestId: req.requestId, now: new Date(now()),
    });
    res.status(201).json({ run: { id: out.runId, candidateCount: out.candidateCount, truncated: out.truncated, outcomes: out.summary } });
  });

  r.get('/jobs/:jobId/match-runs', validate({ params: jobParams }), read, async (req, res) => {
    res.json({ runs: await listMatchRuns(db, req.membership!.organizationId, param(req, 'jobId')) });
  });

  r.get('/match-runs/:runId', validate({ params: runParams }), read, async (req, res) => {
    const q = readQuery.parse(req.query);
    res.json(await readMatchRun(db, { organizationId: req.membership!.organizationId, runId: param(req, 'runId'), userId: req.auth!.userId, requestId: req.requestId, ...q }));
  });

  return r;
}
