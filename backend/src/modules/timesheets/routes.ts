import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';
import { loadProfessional } from '../professionals/service.js';

const idParams = z.object({ id: z.uuid() });
const orgIdParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });
const MAX_MINUTES = 24 * 60;
const EARLY_MS = 6 * 3600_000; // work may start a little before the scheduled time
const LATE_MS = 12 * 3600_000; // and run over, but not without limit

const submitBody = z.object({
  workedStart: z.iso.datetime({ offset: true }),
  workedEnd: z.iso.datetime({ offset: true }),
  breakMinutes: z.number().int().min(0).max(480).default(0),
  note: z.string().trim().max(1000).optional(),
});
const reviewBody = z.object({ decision: z.enum(['approve', 'return']), reason: z.string().trim().min(3).max(1000).optional() });
const listQuery = z.object({
  status: z.enum(['submitted', 'returned', 'approved']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const TS_COLS = `t.id, t.status, t.worked_start, t.worked_end, t.break_minutes, t.minutes_worked, t.note, t.submitted_at, t.reviewed_at, t.review_note`;
const ASG_COLS = `a.id AS assignment_id, a.status AS assignment_status, a.hourly_rate_cents, s.starts_at, s.ends_at, j.title`;
const ASG_FROM = `assignments a JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id`;

/** Worked time must be internally consistent, already past, and plausibly near the scheduled shift. */
export function validateWorked(b: { workedStart: string; workedEnd: string; breakMinutes: number }, shift: { starts_at: Date | string; ends_at: Date | string }, now: Date) {
  const start = new Date(b.workedStart).getTime();
  const end = new Date(b.workedEnd).getTime();
  const field = (name: string, msg: string) => new AppError('VALIDATION_FAILED', msg, { fieldErrors: { [name]: [msg] } });
  if (end <= start) throw field('workedEnd', 'The end time must be after the start time.');
  if (end > now.getTime()) throw field('workedEnd', 'Hours that have not happened yet cannot be submitted.');
  const total = Math.round((end - start) / 60_000);
  if (total > MAX_MINUTES) throw field('workedEnd', 'A single timesheet cannot cover more than 24 hours.');
  if (b.breakMinutes >= total) throw field('breakMinutes', 'The break must be shorter than the time worked.');
  if (start < new Date(shift.starts_at).getTime() - EARLY_MS || end > new Date(shift.ends_at).getTime() + LATE_MS) {
    throw field('workedStart', 'These times are too far from the scheduled shift. Contact the facility if the shift really ran at these times.');
  }
  return { minutes: total - b.breakMinutes };
}

const statusText = (s: string) => s.replace(/_/g, ' ');

/** The professional's side, mounted at /professionals/me. */
export function professionalTimesheetRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router();

  /** Assignments that have started and can carry hours, each with its timesheet (if any). */
  r.get('/timesheets', async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const rows = await db.query(
      `SELECT ${ASG_COLS}, org.name AS organization_name, ${TS_COLS}
         FROM ${ASG_FROM} JOIN organizations org ON org.id = a.organization_id LEFT JOIN timesheets t ON t.assignment_id = a.id
        WHERE a.professional_id = $1 AND a.status IN ('confirmed','completed') AND s.starts_at <= $2
        ORDER BY s.starts_at DESC, a.id LIMIT 100`, [p.id, now()]);
    res.json({ timesheets: rows });
  });

  r.get('/assignments/:id/timesheet', validate({ params: idParams }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const [t] = await db.query<{ id: string }>(`SELECT t.id FROM timesheets t WHERE t.assignment_id = $1 AND t.professional_id = $2`, [param(req, 'id'), p.id]);
    if (!t) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [row] = await db.query(`SELECT ${ASG_COLS}, ${TS_COLS} FROM timesheets t JOIN ${ASG_FROM} ON a.id = t.assignment_id WHERE t.id = $1`, [t.id]);
    const events = await db.query('SELECT actor_kind, action, worked_start, worked_end, break_minutes, minutes_worked, reason, created_at FROM timesheet_events WHERE timesheet_id = $1 ORDER BY seq', [t.id]);
    res.json({ timesheet: row, events });
  });

  /** Creates the timesheet, or corrects it after the facility returned it. Approved timesheets are final. */
  r.put('/assignments/:id/timesheet', validate({ params: idParams, body: submitBody }), async (req, res) => {
    const p = await loadProfessional(db, req.auth!.userId);
    const b = req.body as z.infer<typeof submitBody>;
    const out = await db.transaction(async (tx) => {
      const [a] = await tx.query<{ id: string; status: string; organization_id: string; starts_at: Date; ends_at: Date; title: string }>(
        `SELECT a.id, a.status, a.organization_id, s.starts_at, s.ends_at, j.title FROM ${ASG_FROM} WHERE a.id = $1 AND a.professional_id = $2 FOR UPDATE OF a`, [param(req, 'id'), p.id]);
      if (!a) throw new AppError('NOT_FOUND', 'Resource not found.');
      if (!['confirmed', 'completed'].includes(a.status)) throw new AppError('CONFLICT', `Hours cannot be submitted for an assignment that is ${statusText(a.status)}.`);
      if (new Date(a.starts_at) > now()) throw new AppError('CONFLICT', 'Hours can be submitted once the shift has started.');
      const { minutes } = validateWorked(b, a, now());
      const [existing] = await tx.query<{ id: string; status: string }>('SELECT id, status FROM timesheets WHERE assignment_id = $1 FOR UPDATE', [a.id]);
      if (existing && existing.status !== 'returned') {
        throw new AppError('CONFLICT', existing.status === 'approved' ? 'This timesheet was approved and can no longer be changed.' : 'This timesheet is waiting for the facility to review it.');
      }
      let id: string;
      if (existing) {
        id = existing.id;
        await tx.query(
          `UPDATE timesheets SET status = 'submitted', worked_start = $2, worked_end = $3, break_minutes = $4, minutes_worked = $5, note = $6, submitted_at = now(),
                  reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, updated_at = now() WHERE id = $1`,
          [id, b.workedStart, b.workedEnd, b.breakMinutes, minutes, b.note ?? null]);
      } else {
        const [row] = await tx.query<{ id: string }>(
          `INSERT INTO timesheets (organization_id, assignment_id, professional_id, worked_start, worked_end, break_minutes, minutes_worked, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [a.organization_id, a.id, p.id, b.workedStart, b.workedEnd, b.breakMinutes, minutes, b.note ?? null]);
        id = row!.id;
      }
      await tx.query(
        `INSERT INTO timesheet_events (timesheet_id, actor_user_id, actor_kind, action, worked_start, worked_end, break_minutes, minutes_worked) VALUES ($1,$2,'professional',$3,$4,$5,$6,$7)`,
        [id, req.auth!.userId, existing ? 'resubmitted' : 'submitted', b.workedStart, b.workedEnd, b.breakMinutes, minutes]);
      await audit(tx, { actorUserId: req.auth!.userId, action: existing ? 'timesheet.resubmitted' : 'timesheet.submitted', targetType: 'timesheet', targetId: id, organizationId: a.organization_id, requestId: req.requestId, metadata: { minutes } });
      return { id, minutes, organizationId: a.organization_id, title: a.title };
    });
    await notifyUsers(deps, await orgUserIdsWithPermission(db, out.organizationId, 'applications.manage'), {
      category: 'application_updates', type: 'timesheet.submitted', title: `Timesheet to review: ${out.title}`,
      body: `${(out.minutes / 60).toFixed(2)} hours submitted.`, data: { timesheetId: out.id },
    });
    res.json({ timesheet: { id: out.id, status: 'submitted', minutesWorked: out.minutes } });
  });

  return r;
}

/** The facility's side, mounted at /organizations/:orgId. Every query is scoped by organization_id. */
export function facilityTimesheetRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'applications.read');
  const manage = requireOrgPermission(deps, 'applications.manage');
  const orgOf = (req: Request) => req.membership!.organizationId;

  r.get('/timesheets', validate({ params: orgParams }), read, async (req, res) => {
    const q = listQuery.parse(req.query);
    const args: unknown[] = [orgOf(req)];
    let where = 't.organization_id = $1';
    if (q.status) { args.push(q.status); where += ` AND t.status = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM timesheets t WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${TS_COLS}, ${ASG_COLS}, u.full_name AS professional_name
         FROM timesheets t JOIN ${ASG_FROM} ON a.id = t.assignment_id JOIN professionals p ON p.id = t.professional_id JOIN users u ON u.id = p.user_id
        WHERE ${where} ORDER BY (t.status = 'submitted') DESC, t.submitted_at DESC, t.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ timesheets: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/timesheets/:id', validate({ params: orgIdParams }), read, async (req, res) => {
    const [t] = await db.query<any>(
      `SELECT ${TS_COLS}, ${ASG_COLS}, u.full_name AS professional_name
         FROM timesheets t JOIN ${ASG_FROM} ON a.id = t.assignment_id JOIN professionals p ON p.id = t.professional_id JOIN users u ON u.id = p.user_id
        WHERE t.id = $1 AND t.organization_id = $2`, [param(req, 'id'), orgOf(req)]);
    if (!t) throw new AppError('NOT_FOUND', 'Resource not found.');
    const events = await db.query('SELECT actor_kind, action, worked_start, worked_end, break_minutes, minutes_worked, reason, created_at FROM timesheet_events WHERE timesheet_id = $1 ORDER BY seq', [t.id]);
    res.json({ timesheet: t, events });
  });

  /**
   * Approving records the hours for invoicing and marks a still-confirmed assignment completed. Returning sends it
   * back to the professional with a reason. Approved timesheets cannot be reopened.
   */
  r.post('/timesheets/:id/review', validate({ params: orgIdParams, body: reviewBody }), manage, async (req, res) => {
    const b = req.body as z.infer<typeof reviewBody>;
    if (b.decision === 'return' && !b.reason) throw new AppError('VALIDATION_FAILED', 'A reason is required.', { fieldErrors: { reason: ['Required'] } });
    const out = await db.transaction(async (tx) => {
      const [t] = await tx.query<{ id: string; status: string; assignment_id: string; professional_id: string; minutes_worked: number }>(
        'SELECT id, status, assignment_id, professional_id, minutes_worked FROM timesheets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [param(req, 'id'), orgOf(req)]);
      if (!t) throw new AppError('NOT_FOUND', 'Resource not found.');
      if (t.status !== 'submitted') throw new AppError('CONFLICT', `Only a submitted timesheet can be reviewed; this one is ${t.status}.`);
      const approve = b.decision === 'approve';
      await tx.query(
        `UPDATE timesheets SET status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5, updated_at = now() WHERE id = $1`,
        [t.id, approve ? 'approved' : 'returned', req.auth!.userId, now(), b.reason ?? null]);
      await tx.query(
        `INSERT INTO timesheet_events (timesheet_id, actor_user_id, actor_kind, action, minutes_worked, reason) VALUES ($1,$2,'organization',$3,$4,$5)`,
        [t.id, req.auth!.userId, approve ? 'approved' : 'returned', t.minutes_worked, b.reason ?? null]);
      if (approve) {
        const [a] = await tx.query<{ status: string }>('SELECT status FROM assignments WHERE id = $1 FOR UPDATE', [t.assignment_id]);
        if (a?.status === 'confirmed') {
          await tx.query(`UPDATE assignments SET status = 'completed', updated_at = now() WHERE id = $1`, [t.assignment_id]);
          await tx.query(
            `INSERT INTO assignment_status_history (assignment_id, actor_user_id, actor_kind, from_status, to_status, reason) VALUES ($1,$2,'organization','confirmed','completed','Timesheet approved')`,
            [t.assignment_id, req.auth!.userId]);
        }
      }
      await audit(tx, { actorUserId: req.auth!.userId, action: `timesheet.${approve ? 'approved' : 'returned'}`, targetType: 'timesheet', targetId: t.id, organizationId: orgOf(req), requestId: req.requestId, metadata: { minutes: t.minutes_worked } });
      const [info] = await tx.query<{ user_id: string; title: string }>(
        `SELECT p.user_id, j.title FROM professionals p, assignments a JOIN shifts s ON s.id = a.shift_id JOIN jobs j ON j.id = s.job_id WHERE p.id = $1 AND a.id = $2`, [t.professional_id, t.assignment_id]);
      return { id: t.id, approve, userId: info?.user_id, title: info?.title ?? 'your shift' };
    });
    if (out.userId) {
      await notifyUsers(deps, [out.userId], {
        category: 'application_updates', type: out.approve ? 'timesheet.approved' : 'timesheet.returned',
        title: out.approve ? `Timesheet approved: ${out.title}` : `Timesheet returned: ${out.title}`,
        body: out.approve ? undefined : `Please correct and resubmit. Message from the facility: ${b.reason}`, data: { timesheetId: out.id },
      });
    }
    res.json({ timesheet: { id: out.id, status: out.approve ? 'approved' : 'returned' } });
  });

  return r;
}
