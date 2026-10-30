import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { audit } from '../audit/service.js';
import { notifyUsers } from '../notifications/service.js';

export const TICKET_CATEGORIES = ['account', 'credential', 'job', 'application', 'dispute', 'other'] as const;
const STATUSES = ['open', 'pending_user', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const createBody = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(4000),
  organizationId: z.uuid().optional(),
  relatedType: z.enum(['application', 'job', 'credential', 'organization']).optional(),
  relatedId: z.uuid().optional(),
}).refine((b) => !b.relatedId || !!b.relatedType, { message: 'relatedType is required with relatedId', path: ['relatedType'] });
const messageBody = z.object({ body: z.string().trim().min(1).max(4000) });
const staffMessageBody = messageBody.extend({ internal: z.boolean().default(false) });
const listQuery = z.object({
  status: z.enum(STATUSES).optional(), category: z.enum(TICKET_CATEGORIES).optional(),
  assigned: z.enum(['me', 'unassigned']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const idParams = z.object({ id: z.uuid() });
const TICKET_COLS = 't.id, t.category, t.subject, t.status, t.priority, t.created_at, t.updated_at, t.closed_at';

/** The signed-in user's own support tickets, mounted at /support. A ticket is visible only to its creator and to support staff. */
export function supportRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(10, 3600_000, now);
  const r = Router();
  r.use(needAuth);

  async function ownTicket(req: Request) {
    const [t] = await db.query<{ id: string; status: string }>('SELECT id, status FROM support_tickets WHERE id = $1 AND created_by = $2', [param(req, 'id'), req.auth!.userId]);
    if (!t) throw new AppError('NOT_FOUND', 'Resource not found.');
    return t;
  }

  r.post('/tickets', validate({ body: createBody }), async (req, res) => {
    if (!limiter.allow(`ticket:${req.auth!.userId}`)) throw new AppError('RATE_LIMITED', 'Too many requests. Try again later.');
    const b = req.body as z.infer<typeof createBody>;
    if (b.organizationId) {
      const [m] = await db.query(`SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, [b.organizationId, req.auth!.userId]);
      if (!m) throw new AppError('NOT_FOUND', 'Resource not found.');
    }
    const ticket = await db.transaction(async (tx) => {
      const [t] = await tx.query<{ id: string }>(
        `INSERT INTO support_tickets (created_by, organization_id, category, subject, related_type, related_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.auth!.userId, b.organizationId ?? null, b.category, b.subject, b.relatedType ?? null, b.relatedId ?? null]);
      await tx.query(`INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_kind, body) VALUES ($1,$2,'user',$3)`, [t!.id, req.auth!.userId, b.body]);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'support.ticket_created', targetType: 'support_ticket', targetId: t!.id, organizationId: b.organizationId, requestId: req.requestId, metadata: { category: b.category } });
      return t!;
    });
    res.status(201).json({ ticket: { id: ticket.id, status: 'open' } });
  });

  r.get('/tickets', async (req, res) => {
    const q = listQuery.parse(req.query);
    const args: unknown[] = [req.auth!.userId];
    let where = 't.created_by = $1';
    if (q.status) { args.push(q.status); where += ` AND t.status = $${args.length}`; }
    const [c] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM support_tickets t WHERE ${where}`, args);
    const rows = await db.query(`SELECT ${TICKET_COLS} FROM support_tickets t WHERE ${where} ORDER BY t.updated_at DESC, t.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ tickets: rows, page: q.page, pageSize: q.pageSize, total: Number(c?.n ?? 0) });
  });

  r.get('/tickets/:id', validate({ params: idParams }), async (req, res) => {
    const t = await ownTicket(req);
    const [ticket] = await db.query(`SELECT ${TICKET_COLS}, t.related_type FROM support_tickets t WHERE t.id = $1`, [t.id]);
    const messages = await db.query(`SELECT id, author_kind, body, created_at FROM support_ticket_messages WHERE ticket_id = $1 AND NOT internal ORDER BY seq`, [t.id]);
    res.json({ ticket, messages });
  });

  r.post('/tickets/:id/messages', validate({ params: idParams, body: messageBody }), async (req, res) => {
    const t = await ownTicket(req);
    if (t.status === 'closed') throw new AppError('CONFLICT', 'This request is closed. Open a new one if you still need help.');
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_kind, body) VALUES ($1,$2,'user',$3)`, [t.id, req.auth!.userId, req.body.body]);
      await tx.query(`UPDATE support_tickets SET status = 'open', updated_at = now(), closed_at = NULL WHERE id = $1`, [t.id]); // a reply reopens resolved/pending tickets
    });
    res.status(201).json({ ticket: { id: t.id, status: 'open' } });
  });

  r.post('/tickets/:id/close', validate({ params: idParams }), async (req, res) => {
    const t = await ownTicket(req);
    await db.query(`UPDATE support_tickets SET status = 'closed', closed_at = coalesce(closed_at, now()), updated_at = now() WHERE id = $1`, [t.id]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'support.ticket_closed_by_user', targetType: 'support_ticket', targetId: t.id, requestId: req.requestId });
    res.json({ ticket: { id: t.id, status: 'closed' } });
  });

  return r;
}

/** Support staff queue, mounted at /admin/support. Requires the support permission and an MFA session. */
export function adminSupportRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const staff = requirePlatformPermission('admin.support');

  async function load(req: Request) {
    const [t] = await db.query<{ id: string; created_by: string; subject: string; status: string }>('SELECT id, created_by, subject, status FROM support_tickets WHERE id = $1', [param(req, 'id')]);
    if (!t) throw new AppError('NOT_FOUND', 'Resource not found.');
    return t;
  }

  r.get('/tickets', staff, async (req, res) => {
    const q = listQuery.parse(req.query);
    const args: unknown[] = [q.status ?? 'open'];
    let where = 't.status = $1';
    if (q.category) { args.push(q.category); where += ` AND t.category = $${args.length}`; }
    if (q.assigned === 'me') { args.push(req.auth!.userId); where += ` AND t.assigned_to = $${args.length}`; }
    if (q.assigned === 'unassigned') where += ' AND t.assigned_to IS NULL';
    const [c] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM support_tickets t WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${TICKET_COLS}, t.assigned_to, u.full_name AS requester_name
         FROM support_tickets t JOIN users u ON u.id = t.created_by WHERE ${where}
        ORDER BY array_position(ARRAY['urgent','high','normal','low'], t.priority), t.created_at, t.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ tickets: rows, page: q.page, pageSize: q.pageSize, total: Number(c?.n ?? 0) });
  });

  r.get('/tickets/:id', validate({ params: idParams }), staff, async (req, res) => {
    const t = await load(req);
    const [ticket] = await db.query(
      `SELECT ${TICKET_COLS}, t.related_type, t.related_id, t.organization_id, t.assigned_to, u.full_name AS requester_name, u.email AS requester_email
         FROM support_tickets t JOIN users u ON u.id = t.created_by WHERE t.id = $1`, [t.id]);
    const messages = await db.query('SELECT id, author_kind, internal, body, created_at FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY seq', [t.id]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.support_ticket_viewed', targetType: 'support_ticket', targetId: t.id, requestId: req.requestId });
    res.json({ ticket, messages });
  });

  r.post('/tickets/:id/messages', validate({ params: idParams, body: staffMessageBody }), staff, async (req, res) => {
    const t = await load(req);
    if (t.status === 'closed') throw new AppError('CONFLICT', 'This ticket is closed.');
    const b = req.body as z.infer<typeof staffMessageBody>;
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_kind, internal, body) VALUES ($1,$2,'staff',$3,$4)`, [t.id, req.auth!.userId, b.internal, b.body]);
      if (!b.internal) await tx.query(`UPDATE support_tickets SET status = 'pending_user', updated_at = now() WHERE id = $1`, [t.id]);
      await audit(tx, { actorUserId: req.auth!.userId, action: b.internal ? 'admin.support_internal_note' : 'admin.support_reply', targetType: 'support_ticket', targetId: t.id, requestId: req.requestId });
    });
    if (!b.internal) {
      await notifyUsers(deps, [t.created_by], { category: 'support_updates', type: 'support.reply', title: 'Support replied to your request', data: { ticketId: t.id } });
    }
    res.status(201).json({ ticket: { id: t.id, status: b.internal ? t.status : 'pending_user' } });
  });

  r.post('/tickets/:id/assign', validate({ params: idParams, body: z.object({ assignToMe: z.boolean() }) }), staff, async (req, res) => {
    const t = await load(req);
    await db.query('UPDATE support_tickets SET assigned_to = $2, updated_at = now() WHERE id = $1', [t.id, req.body.assignToMe ? req.auth!.userId : null]);
    await audit(db, { actorUserId: req.auth!.userId, action: req.body.assignToMe ? 'admin.support_assigned' : 'admin.support_unassigned', targetType: 'support_ticket', targetId: t.id, requestId: req.requestId });
    res.json({ ticket: { id: t.id, assignedTo: req.body.assignToMe ? req.auth!.userId : null } });
  });

  r.post('/tickets/:id/status', validate({ params: idParams, body: z.object({ status: z.enum(STATUSES), priority: z.enum(PRIORITIES).optional() }) }), staff, async (req, res) => {
    const t = await load(req);
    const b = req.body as { status: (typeof STATUSES)[number]; priority?: (typeof PRIORITIES)[number] };
    await db.query(
      `UPDATE support_tickets SET status = $2, priority = coalesce($3, priority), updated_at = now(),
         closed_at = CASE WHEN $2 IN ('closed','resolved') THEN coalesce(closed_at, now()) ELSE NULL END WHERE id = $1`, [t.id, b.status, b.priority ?? null]);
    await audit(db, { actorUserId: req.auth!.userId, action: `admin.support_status.${b.status}`, targetType: 'support_ticket', targetId: t.id, requestId: req.requestId, metadata: { from: t.status } });
    if (b.status === 'resolved') {
      await notifyUsers(deps, [t.created_by], { category: 'support_updates', type: 'support.resolved', title: 'Your support request was marked resolved', data: { ticketId: t.id } });
    }
    res.json({ ticket: { id: t.id, status: b.status } });
  });

  return r;
}
