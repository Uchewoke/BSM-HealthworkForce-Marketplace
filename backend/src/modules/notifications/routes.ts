import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { CATEGORIES } from './service.js';

const listQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const prefsBody = z.object({
  preferences: z.array(z.object({ category: z.enum(CATEGORIES as [string, ...string[]]), emailEnabled: z.boolean() })).max(CATEGORIES.length),
});
const idParams = z.object({ id: z.uuid() });
const COLS = 'id, category, type, title, body, data, read_at, email_status, created_at';

/** The signed-in user's own notifications, mounted at /notifications. Everything is scoped to req.auth.userId. */
export function notificationRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);

  r.get('/', async (req, res) => {
    const q = listQuery.parse(req.query);
    const unreadOnly = q.unread === 'true';
    const where = `user_id = $1${unreadOnly ? ' AND read_at IS NULL' : ''}`;
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE ${where}`, [req.auth!.userId]);
    const rows = await db.query(`SELECT ${COLS} FROM notifications WHERE ${where} ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [req.auth!.userId, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ notifications: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/unread-count', async (req, res) => {
    const [row] = await db.query<{ n: string }>('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.auth!.userId]);
    res.json({ unread: Number(row?.n ?? 0) });
  });

  r.post('/read-all', async (req, res) => {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.auth!.userId]);
    res.status(204).end();
  });

  r.get('/preferences', async (req, res) => {
    const rows = await db.query<{ category: string; email_enabled: boolean }>('SELECT category, email_enabled FROM notification_preferences WHERE user_id = $1', [req.auth!.userId]);
    res.json({ preferences: CATEGORIES.map((c) => ({ category: c, emailEnabled: rows.find((x) => x.category === c)?.email_enabled ?? true })) });
  });

  r.put('/preferences', validate({ body: prefsBody }), async (req, res) => {
    for (const p of (req.body as z.infer<typeof prefsBody>).preferences) {
      await db.query(
        `INSERT INTO notification_preferences (user_id, category, email_enabled) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, category) DO UPDATE SET email_enabled = EXCLUDED.email_enabled`, [req.auth!.userId, p.category, p.emailEnabled]);
    }
    res.json({ ok: true });
  });

  r.post('/:id/read', validate({ params: idParams }), async (req, res) => {
    const rows = await db.query('UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id', [param(req, 'id'), req.auth!.userId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    res.status(204).end();
  });

  return r;
}
