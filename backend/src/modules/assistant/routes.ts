import Anthropic from '@anthropic-ai/sdk';
import { Router, type Request, type RequestHandler } from 'express';
import { orgRoleCan } from '@bsm/permissions';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AssistantTool } from '../../integrations/assistant.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { audit } from '../audit/service.js';
import { agencySystemPrompt, agencyTools, facilitySystemPrompt, facilityTools, type JobDraft } from './tools.js';

const orgParams = z.object({ orgId: z.uuid() });
/** Text only, alternating from a user turn to a user turn. Tool results never travel through the client. */
const chatBody = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) })).min(1).max(20),
}).refine((b) => b.messages[0]?.role === 'user', { message: 'The conversation must start with a user message.', path: ['messages'] })
  .refine((b) => b.messages.at(-1)?.role === 'user', { message: 'The last message must be from the user.', path: ['messages'] });

type Kind = 'facility' | 'agency';

function assistantRoutes(deps: AppDeps, kind: Kind) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(30, 3600_000, now, deps.limits);
  const r = Router({ mergeParams: true });
  const permission = kind === 'facility' ? 'jobs.read' : 'agency.jobs.read';
  const guard: RequestHandler[] = [requireOrgPermission(deps, permission), requireOrgType(deps, kind)];

  r.get('/status', validate({ params: orgParams }), ...guard, async (_req, res) => { res.json({ configured: deps.assistant.configured }); });

  r.post('/', validate({ params: orgParams, body: chatBody }), ...guard, requireApprovedOrg(deps), async (req: Request, res) => {
    if (!deps.assistant.configured) throw new AppError('UNAVAILABLE', 'The AI assistant is not set up on this server yet.');
    if (!(await limiter.allow(`assistant:${req.auth!.userId}`))) throw new AppError('RATE_LIMITED', 'You have used the assistant a lot in the last hour. Please try again later.');
    const orgId = req.membership!.organizationId;
    const role = req.membership!.role;
    const today = new Date(now()).toISOString().slice(0, 10);
    const ctx = { db, organizationId: orgId, role, now };
    let draft: JobDraft | null = null;
    const tools: AssistantTool[] = kind === 'facility' ? facilityTools(ctx, (d) => { draft = d; }) : agencyTools(ctx);
    const system = kind === 'facility' ? facilitySystemPrompt(today, orgRoleCan(role, 'billing.read')) : agencySystemPrompt(today);

    let result;
    try {
      result = await deps.assistant.run({ system, messages: req.body.messages, tools });
    } catch (e) {
      // Log the class and status only: never the conversation, which can mention business data.
      logger.error({ err: e instanceof Error ? e.name : 'unknown', status: e instanceof Anthropic.APIError ? e.status : undefined }, 'assistant request failed');
      if (e instanceof Anthropic.RateLimitError) throw new AppError('UNAVAILABLE', 'The assistant is busy right now. Please try again in a minute.');
      throw new AppError('UNAVAILABLE', 'The assistant could not answer just now. Please try again.');
    }
    await audit(db, {
      actorUserId: req.auth!.userId, action: 'assistant.request', targetType: 'organization', targetId: orgId, organizationId: orgId, requestId: req.requestId,
      metadata: { tools: result.toolsUsed, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, refused: result.refused, incomplete: result.incomplete, draft: draft !== null },
    });
    res.json({ reply: result.reply, toolsUsed: [...new Set(result.toolsUsed)], draft, refused: result.refused, incomplete: result.incomplete });
  });

  return r;
}

/** Resolves only for the right kind of organization; run after requireOrgPermission. */
function requireOrgType(deps: AppDeps, kind: Kind): RequestHandler {
  return async (req, _res, next) => {
    const [o] = await deps.db.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1', [req.membership!.organizationId]);
    if (o?.type !== kind) return next(new AppError('NOT_FOUND', 'Resource not found.'));
    next();
  };
}

/** Mounted at /organizations/:orgId/assistant */
export const facilityAssistantRoutes = (deps: AppDeps) => assistantRoutes(deps, 'facility');
/** Mounted at /organizations/:orgId/agency/assistant */
export const agencyAssistantRoutes = (deps: AppDeps) => assistantRoutes(deps, 'agency');
