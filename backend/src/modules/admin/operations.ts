import { Router, type RequestHandler } from 'express';
import { platformRoleCan } from '@bsm/permissions';
import { z } from 'zod';
import { requirePlatformMember, requirePlatformPermission } from '../../middleware/access.js';
import type { Metrics } from '../../middleware/observability.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { US_STATES } from '../../shared/us-states.js';
import { audit } from '../audit/service.js';
import { JOB_STATUSES } from '../jobs/schemas.js';
import { transitionJob } from '../jobs/service.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const page = { page: z.coerce.number().int().min(1).max(10_000).default(1) };
const idParams = z.object({ id: z.uuid() });
const count = async (db: AppDeps['db'], sql: string, args: unknown[] = []) => Number((await db.query<{ n: string }>(sql, args))[0]?.n ?? 0);
const grouped = async (db: AppDeps['db'], sql: string, args: unknown[] = []) => Object.fromEntries((await db.query<{ k: string; n: string }>(sql, args)).map((r) => [r.k, Number(r.n)]));

const auditQuery = z.object({
  actorUserId: z.uuid().optional(),
  actorEmail: z.string().trim().min(3).max(254).optional(),
  action: z.string().trim().min(1).max(100).regex(/^[a-z0-9_.]+$/).optional(),   // prefix match, e.g. "credential." or "job.status."
  targetType: z.string().trim().min(1).max(60).optional(),
  targetId: z.string().trim().min(1).max(100).optional(),
  organizationId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(100), ...page,
});
const userSearch = z.object({ q: z.string().trim().min(2).max(100), pageSize: z.coerce.number().int().min(1).max(50).default(20), ...page });
const userStatusBody = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(1000) });
const jobList = z.object({
  status: z.enum(JOB_STATUSES).optional(), organizationId: z.uuid().optional(), q: z.string().trim().min(1).max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(20), ...page,
});
const jobStatusBody = z.object({ to: z.enum(['paused', 'closed', 'cancelled']), reason: z.string().trim().min(3).max(1000) });
const stateBody = z.object({ enabled: z.boolean(), compactMember: z.boolean().nullable().optional(), notes: z.string().trim().max(1000).nullable().optional() });
const stateParams = z.object({ state: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(US_STATES)) });

/** Oversight and operations for platform staff, mounted at /admin. */
export function adminOperationsRoutes(deps: AppDeps, needAuth: RequestHandler, metrics: Metrics) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  r.use(needAuth);
  const can = (req: Parameters<RequestHandler>[0], p: Parameters<typeof platformRoleCan>[1]) => platformRoleCan(req.auth!.platformRole!, p);

  // ---- dashboard: each role only sees the sections its permissions allow
  r.get('/dashboard', requirePlatformMember, async (req, res) => {
    const out: Record<string, unknown> = { role: req.auth!.platformRole, generatedAt: new Date(now()).toISOString() };
    if (can(req, 'admin.facility_review')) {
      out.organizations = await grouped(db, `SELECT status AS k, count(*) AS n FROM organizations WHERE type = 'facility' GROUP BY status`);
    }
    if (can(req, 'admin.credential_review')) {
      out.credentials = await grouped(db, `SELECT status AS k, count(*) AS n FROM credentials GROUP BY status`);
    }
    if (can(req, 'admin.marketplace_oversight')) {
      out.jobs = await grouped(db, `SELECT status AS k, count(*) AS n FROM jobs GROUP BY status`);
      out.applicationsLast7Days = await count(db, `SELECT count(*) AS n FROM applications WHERE created_at > $1`, [new Date(now() - 7 * 86_400_000)]);
    }
    if (can(req, 'admin.support')) {
      out.supportTickets = await grouped(db, `SELECT status AS k, count(*) AS n FROM support_tickets GROUP BY status`);
      out.unassignedOpenTickets = await count(db, `SELECT count(*) AS n FROM support_tickets WHERE status = 'open' AND assigned_to IS NULL`);
    }
    if (can(req, 'admin.user_lookup')) {
      out.users = { total: await count(db, 'SELECT count(*) AS n FROM users'), suspended: await count(db, `SELECT count(*) AS n FROM users WHERE status = 'suspended'`) };
    }
    res.json(out);
  });

  // ---- audit search
  r.get('/audit-logs', requirePlatformPermission('admin.audit_read'), async (req, res) => {
    const q = auditQuery.parse(req.query);
    const args: unknown[] = [];
    let where = 'TRUE';
    const add = (clause: string, v: unknown) => { args.push(v); where += ` AND ${clause.replace('?', `$${args.length}`)}`; };
    if (q.actorUserId) add('a.actor_user_id = ?', q.actorUserId);
    if (q.actorEmail) add(`lower(u.email) = ?`, q.actorEmail.toLowerCase());
    if (q.action) add(`a.action LIKE ? ESCAPE '\\'`, `${escapeLike(q.action)}%`);
    if (q.targetType) add('a.target_type = ?', q.targetType);
    if (q.targetId) add('a.target_id = ?', q.targetId);
    if (q.organizationId) add('a.organization_id = ?', q.organizationId);
    if (q.from) add('a.created_at >= ?', q.from);
    if (q.to) add('a.created_at <= ?', q.to);
    const total = await count(db, `SELECT count(*) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.target_type, a.target_id, a.organization_id, a.request_id, a.metadata, a.created_at
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where}
        ORDER BY a.created_at DESC, a.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    // Reading the audit log is itself recorded (filters only, never the results).
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.audit_read', requestId: req.requestId, metadata: { filters: Object.keys(req.query) } });
    res.json({ auditLogs: rows, page: q.page, pageSize: q.pageSize, total });
  });

  // ---- users
  r.get('/users', requirePlatformPermission('admin.user_lookup'), async (req, res) => {
    const q = userSearch.parse(req.query);
    const like = `%${escapeLike(q.q)}%`;
    const where = `(u.email ILIKE $1 ESCAPE '\\' OR u.full_name ILIKE $1 ESCAPE '\\')`;
    const total = await count(db, `SELECT count(*) AS n FROM users u WHERE ${where}`, [like]);
    const rows = await db.query(
      `SELECT u.id, u.email, u.full_name, u.status, u.platform_role, u.email_verified_at, u.created_at FROM users u
        WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT $2 OFFSET $3`, [like, q.pageSize, (q.page - 1) * q.pageSize]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.user_search', requestId: req.requestId, metadata: { queryLength: q.q.length, results: total } });
    res.json({ users: rows, page: q.page, pageSize: q.pageSize, total });
  });

  r.get('/users/:id', validate({ params: idParams }), requirePlatformPermission('admin.user_lookup'), async (req, res) => {
    const id = param(req, 'id');
    const [user] = await db.query('SELECT id, email, full_name, status, platform_role, email_verified_at, failed_login_count, locked_until, created_at FROM users WHERE id = $1', [id]);
    if (!user) throw new AppError('NOT_FOUND', 'Resource not found.');
    const memberships = await db.query(
      `SELECT m.id, m.role, m.status, o.id AS organization_id, o.name AS organization_name, o.status AS organization_status
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY m.created_at`, [id]);
    const [professional] = await db.query(
      `SELECT p.id, p.account_status, pr.name AS profession FROM professionals p JOIN professions pr ON pr.id = p.profession_id WHERE p.user_id = $1`, [id]);
    const booking = professional ? (await db.query<{ undone_30d: string; undone_total: string }>(
      `SELECT count(*) FILTER (WHERE undone_at > now() - interval '30 days') AS undone_30d, count(*) FILTER (WHERE undone_at IS NOT NULL) AS undone_total FROM assignments WHERE professional_id = $1`, [(professional as { id: string }).id]))[0] : null;
    const activeSessions = await count(db, 'SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()', [id]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.user_viewed', targetType: 'user', targetId: id, requestId: req.requestId });
    res.json({ user, memberships, professional: professional ? { ...(professional as object), undoneLast30Days: Number(booking?.undone_30d ?? 0), undoneTotal: Number(booking?.undone_total ?? 0) } : null, activeSessions });
  });

  r.post('/users/:id/status', validate({ params: idParams, body: userStatusBody }), requirePlatformPermission('admin.user_manage'), async (req, res) => {
    const id = param(req, 'id');
    const b = req.body as z.infer<typeof userStatusBody>;
    if (id === req.auth!.userId) throw new AppError('CONFLICT', 'You cannot change your own account status.');
    const [target] = await db.query<{ status: string; platform_role: string | null }>('SELECT status, platform_role FROM users WHERE id = $1', [id]);
    if (!target) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (target.platform_role && req.auth!.platformRole !== 'platform_super_admin') {
      throw new AppError('FORBIDDEN', 'Only a super admin can change a platform user.');
    }
    if (target.status === b.status) throw new AppError('CONFLICT', `The account is already ${b.status}.`);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE users SET status = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [id, b.status]);
      if (b.status === 'suspended') await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(tx, {
        actorUserId: req.auth!.userId, action: b.status === 'suspended' ? 'admin.user_suspended' : 'admin.user_reactivated',
        targetType: 'user', targetId: id, requestId: req.requestId, metadata: { reason: b.reason },
      });
    });
    res.json({ user: { id, status: b.status } });
  });

  // ---- marketplace / job oversight
  const oversight = requirePlatformPermission('admin.marketplace_oversight');
  r.get('/jobs', oversight, async (req, res) => {
    const q = jobList.parse(req.query);
    const args: unknown[] = [];
    let where = 'TRUE';
    const add = (clause: string, v: unknown) => { args.push(v); where += ` AND ${clause.replace(/\?/g, `$${args.length}`)}`; };
    if (q.status) add('j.status = ?', q.status);
    if (q.organizationId) add('j.organization_id = ?', q.organizationId);
    if (q.q) add(`(j.title ILIKE ? ESCAPE '\\' OR o.name ILIKE ? ESCAPE '\\')`, `%${escapeLike(q.q)}%`);
    const total = await count(db, `SELECT count(*) AS n FROM jobs j JOIN organizations o ON o.id = j.organization_id WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT j.id, j.title, j.status, j.employment_type, j.published_at, j.created_at, o.id AS organization_id, o.name AS organization_name,
              o.status AS organization_status, l.state, (SELECT count(*) FROM applications a WHERE a.job_id = j.id) AS applications
         FROM jobs j JOIN organizations o ON o.id = j.organization_id JOIN facility_locations l ON l.id = j.location_id
        WHERE ${where} ORDER BY j.updated_at DESC, j.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ jobs: rows, page: q.page, pageSize: q.pageSize, total });
  });

  r.get('/jobs/:id', validate({ params: idParams }), oversight, async (req, res) => {
    const id = param(req, 'id');
    const [job] = await db.query(
      `SELECT j.*, o.name AS organization_name, o.status AS organization_status, l.city, l.state FROM jobs j
         JOIN organizations o ON o.id = j.organization_id JOIN facility_locations l ON l.id = j.location_id WHERE j.id = $1`, [id]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    const requirements = await db.query('SELECT kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1', [id]);
    const shifts = await db.query('SELECT id, starts_at, ends_at, positions, status FROM shifts WHERE job_id = $1 ORDER BY starts_at', [id]);
    const history = await db.query('SELECT from_status, to_status, reason, created_at FROM job_events WHERE job_id = $1 ORDER BY seq', [id]);
    const applications = await grouped(db, `SELECT status AS k, count(*) AS n FROM applications WHERE job_id = $1 GROUP BY status`, [id]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.job_viewed', targetType: 'job', targetId: id, requestId: req.requestId });
    res.json({ job, requirements, shifts, history, applications });
  });

  /** Platform intervention (e.g. a misleading or unlawful listing): pause, close or cancel with a recorded reason. */
  r.post('/jobs/:id/status', validate({ params: idParams, body: jobStatusBody }), oversight, async (req, res) => {
    const id = param(req, 'id');
    const b = req.body as z.infer<typeof jobStatusBody>;
    const [job] = await db.query<{ organization_id: string; title: string }>('SELECT organization_id, title FROM jobs WHERE id = $1', [id]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    const out = await transitionJob(db, { orgId: job.organization_id, jobId: id, to: b.to, actorUserId: req.auth!.userId, reason: b.reason, requestId: req.requestId, nowMs: now() });
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.job_intervention', targetType: 'job', targetId: id, organizationId: job.organization_id, requestId: req.requestId, metadata: { to: b.to } });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, job.organization_id, 'jobs.manage'), {
      category: 'review_decisions', type: `job.admin_${b.to}`, title: `BSM ${b.to} your job: ${job.title}`, body: b.reason, data: { jobId: id },
    });
    res.json({ job: { id: out.id, status: out.status, previousStatus: out.previousStatus } });
  });

  // ---- organization lookup (any status)
  r.get('/organization-lookup', requirePlatformPermission('admin.facility_review'), async (req, res) => {
    const q = z.object({ q: z.string().trim().min(2).max(100), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const like = `%${escapeLike(q.q)}%`;
    const rows = await db.query(
      `SELECT id, name, legal_name, type, status, state, created_at FROM organizations
        WHERE name ILIKE $1 ESCAPE '\\' OR legal_name ILIKE $1 ESCAPE '\\' ORDER BY created_at DESC, id LIMIT $2`, [like, q.pageSize]);
    res.json({ organizations: rows });
  });

  // ---- state configuration
  r.get('/states', requirePlatformPermission('admin.taxonomy_manage'), async (_req, res) => {
    const rows = await db.query<{ state: string; enabled: boolean; compact_member: boolean | null; notes: string | null }>('SELECT state, enabled, compact_member, notes FROM state_configurations');
    const by = new Map(rows.map((x) => [x.state, x]));
    res.json({ states: US_STATES.map((s) => ({ state: s, enabled: by.get(s)?.enabled ?? true, compactMember: by.get(s)?.compact_member ?? null, notes: by.get(s)?.notes ?? null, configured: by.has(s) })) });
  });

  r.put('/states/:state', validate({ params: stateParams, body: stateBody }), requirePlatformPermission('admin.taxonomy_manage'), async (req, res) => {
    const state = stateParams.parse(req.params).state;
    const b = req.body as z.infer<typeof stateBody>;
    await db.query(
      `INSERT INTO state_configurations (state, enabled, compact_member, notes, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (state) DO UPDATE SET enabled = EXCLUDED.enabled, compact_member = EXCLUDED.compact_member, notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by, updated_at = now()`, [state, b.enabled, b.compactMember ?? null, b.notes ?? null, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.state_configured', targetType: 'state', targetId: state, requestId: req.requestId, metadata: { enabled: b.enabled } });
    res.json({ state: { state, enabled: b.enabled, compactMember: b.compactMember ?? null, notes: b.notes ?? null } });
  });

  // ---- operational metrics (per process)
  r.get('/metrics', requirePlatformPermission('admin.settings_manage'), (_req, res) => { res.json(metrics.snapshot()); });

  return r;
}
