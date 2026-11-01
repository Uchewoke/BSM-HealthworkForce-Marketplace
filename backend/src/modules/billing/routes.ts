import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Queryable } from '../../db/index.js';
import { requireOrgPermission, requirePlatformPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { notifyUsers, orgUserIdsWithPermission } from '../notifications/service.js';

const FEE_KEY = 'platform_fee';
const idParams = z.object({ id: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });
const orgInvoiceParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
};
const feeBody = z.object({ bps: z.number().int().min(0).max(10_000) });
const periodBody = z.object({ organizationId: z.uuid(), periodStart: z.iso.date(), periodEnd: z.iso.date() })
  .refine((b) => b.periodEnd >= b.periodStart, { message: 'The period must end on or after it starts.', path: ['periodEnd'] });
const issueBody = z.object({ dueInDays: z.number().int().min(0).max(120).default(30) });
const payBody = z.object({
  method: z.enum(['bank_transfer', 'check', 'card_offline', 'other']),
  reference: z.string().trim().min(2).max(200),
  paidOn: z.iso.date().optional(),
});
const voidBody = z.object({ reason: z.string().trim().min(3).max(1000) });
const listQuery = z.object({ status: z.enum(['draft', 'issued', 'paid', 'void']).optional(), organizationId: z.uuid().optional(), ...paging });
const unbilledQuery = z.object({ organizationId: z.uuid(), periodStart: z.iso.date(), periodEnd: z.iso.date() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const formatCents =(c: number | string) => `$${(Number(c) / 100).toFixed(2)}`;

/** The fee rate is a business decision, so there is no default: invoices cannot be generated until staff set one. */
async function loadFeeBps(q: Queryable): Promise<number | null> {
  const [row] = await q.query<{ value: { bps?: number } }>('SELECT value FROM platform_settings WHERE key = $1', [FEE_KEY]);
  return typeof row?.value?.bps === 'number' ? row.value.bps : null;
}

interface Billable { assignment_id: string; title: string; starts_at: Date; minutes: number; rate_cents: number }

/**
 * Completed assignments with an APPROVED timesheet whose work ended inside the period and that are not on a live invoice.
 * Minutes come from the approved timesheet, never from the scheduled shift.
 */
async function findBillable(q: Queryable, organizationId: string, periodStart: string, periodEnd: string): Promise<Billable[]> {
  return q.query<Billable>(
    `SELECT asg.id AS assignment_id, j.title, s.starts_at, asg.hourly_rate_cents AS rate_cents,
            t.minutes_worked AS minutes
       FROM assignments asg JOIN shifts s ON s.id = asg.shift_id JOIN jobs j ON j.id = s.job_id
       JOIN timesheets t ON t.assignment_id = asg.id AND t.status = 'approved'
      WHERE asg.organization_id = $1 AND asg.status = 'completed'
        AND t.worked_end >= $2::date AND t.worked_end < ($3::date + 1)
        AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.assignment_id = asg.id AND NOT il.voided)
      ORDER BY s.starts_at, asg.id`, [organizationId, periodStart, periodEnd]);
}

/** Completed or confirmed shifts in the period that cannot be invoiced yet because no timesheet has been approved. */
async function findAwaitingTimesheet(q: Queryable, organizationId: string, periodStart: string, periodEnd: string) {
  return q.query<{ assignment_id: string; title: string; starts_at: Date; timesheet_status: string | null }>(
    `SELECT asg.id AS assignment_id, j.title, s.starts_at, t.status AS timesheet_status
       FROM assignments asg JOIN shifts s ON s.id = asg.shift_id JOIN jobs j ON j.id = s.job_id LEFT JOIN timesheets t ON t.assignment_id = asg.id
      WHERE asg.organization_id = $1 AND asg.status IN ('confirmed','completed') AND s.ends_at >= $2::date AND s.ends_at < ($3::date + 1) AND s.ends_at <= now()
        AND (t.id IS NULL OR t.status <> 'approved')
        AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.assignment_id = asg.id AND NOT il.voided)
      ORDER BY s.starts_at, asg.id`, [organizationId, periodStart, periodEnd]);
}

export const lineAmounts = (b: { minutes: number; rate_cents: number }, bps: number) => {
  const gross = Math.round((b.rate_cents * b.minutes) / 60);
  return { gross, amount: Math.round((gross * bps) / 10_000) };
};

const INVOICE_COLS = `i.id, i.organization_id, o.name AS organization_name, i.number, i.status, i.period_start, i.period_end, i.fee_bps, i.total_cents,
  i.due_date, i.issued_at, i.paid_at, i.payment_method, i.payment_reference, i.void_reason, i.voided_at, i.created_at`;

async function loadInvoice(q: Queryable, id: string, organizationId?: string) {
  const [invoice] = await q.query<Record<string, any>>(
    `SELECT ${INVOICE_COLS} FROM invoices i JOIN organizations o ON o.id = i.organization_id
      WHERE i.id = $1 AND ($2::uuid IS NULL OR i.organization_id = $2::uuid)${organizationId ? ` AND i.issued_at IS NOT NULL` : ''}`, [id, organizationId ?? null]);
  if (!invoice) throw new AppError('NOT_FOUND', 'Resource not found.');
  const lines = await q.query(
    `SELECT id, description, minutes, rate_cents, gross_cents, fee_bps, amount_cents, voided FROM invoice_lines WHERE invoice_id = $1 ORDER BY created_at, id`, [id]);
  return { invoice, lines };
}

/** Staff billing tools, mounted at /admin/billing. Recording a payment is a manual bookkeeping step: nothing is charged here. */
export function adminBillingRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  r.use(needAuth);
  const billing = requirePlatformPermission('admin.billing_manage');

  r.get('/fee', billing, async (_req, res) => {
    res.json({ bps: await loadFeeBps(db), configured: (await loadFeeBps(db)) !== null });
  });

  r.put('/fee', billing, validate({ body: feeBody }), async (req, res) => {
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = platform_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [FEE_KEY, JSON.stringify({ bps: req.body.bps }), req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'admin.platform_fee_updated', targetType: 'platform_setting', targetId: FEE_KEY, requestId: req.requestId, metadata: { bps: req.body.bps } });
    res.json({ bps: req.body.bps, configured: true });
  });

  /** Name search so staff can pick the organization to invoice. Only id, name and type are returned. */
  r.get('/organizations', billing, async (req, res) => {
    const q = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const rows = await db.query(
      `SELECT id, name, type FROM organizations WHERE lower(name) LIKE $1 ORDER BY name, id LIMIT 20`,
      [`%${escapeLike(q.q.toLowerCase())}%`]);
    res.json({ organizations: rows });
  });

  /** Preview of what an invoice for the period would contain. */
  r.get('/unbilled', billing, async (req, res) => {
    const q = unbilledQuery.parse(req.query);
    const bps = await loadFeeBps(db);
    const rows = await findBillable(db, q.organizationId, q.periodStart, q.periodEnd);
    const items = rows.map((b) => ({ ...b, ...(bps === null ? { gross: lineAmounts(b, 0).gross, amount: null } : lineAmounts(b, bps)) }));
    res.json({ feeBps: bps, items, awaitingTimesheet: await findAwaitingTimesheet(db, q.organizationId, q.periodStart, q.periodEnd) });
  });

  r.get('/invoices', billing, async (req, res) => {
    const q = listQuery.parse(req.query);
    const args: unknown[] = [];
    let where = 'TRUE';
    if (q.status) { args.push(q.status); where += ` AND i.status = $${args.length}`; }
    if (q.organizationId) { args.push(q.organizationId); where += ` AND i.organization_id = $${args.length}`; }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM invoices i WHERE ${where}`, args);
    const rows = await db.query(
      `SELECT ${INVOICE_COLS} FROM invoices i JOIN organizations o ON o.id = i.organization_id WHERE ${where}
        ORDER BY i.created_at DESC, i.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ invoices: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/invoices/:id', validate({ params: idParams }), billing, async (req, res) => {
    res.json(await loadInvoice(db, param(req, 'id')));
  });

  r.post('/invoices', validate({ body: periodBody }), billing, async (req, res) => {
    const b = req.body as z.infer<typeof periodBody>;
    const out = await db.transaction(async (tx) => {
      const bps = await loadFeeBps(tx);
      if (bps === null) throw new AppError('CONFLICT', 'Set the platform fee before generating invoices.');
      const [org] = await tx.query<{ id: string }>('SELECT id FROM organizations WHERE id = $1', [b.organizationId]);
      if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
      const billable = await findBillable(tx, b.organizationId, b.periodStart, b.periodEnd);
      if (billable.length === 0) throw new AppError('CONFLICT', 'There are no completed, unbilled assignments for this organization in that period.');
      const lines = billable.map((x) => ({ x, ...lineAmounts(x, bps) }));
      const total = lines.reduce((sum, l) => sum + l.amount, 0);
      const [inv] = await tx.query<{ id: string }>(
        `INSERT INTO invoices (organization_id, period_start, period_end, fee_bps, total_cents, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.organizationId, b.periodStart, b.periodEnd, bps, total, req.auth!.userId]);
      for (const l of lines) {
        await tx.query(
          `INSERT INTO invoice_lines (invoice_id, assignment_id, description, minutes, rate_cents, gross_cents, fee_bps, amount_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [inv!.id, l.x.assignment_id, `${l.x.title} — shift on ${new Date(l.x.starts_at).toISOString().slice(0, 10)}`, l.x.minutes, l.x.rate_cents, l.gross, bps, l.amount]);
      }
      await audit(tx, { actorUserId: req.auth!.userId, action: 'invoice.created', targetType: 'invoice', targetId: inv!.id, organizationId: b.organizationId, requestId: req.requestId, metadata: { lines: lines.length, totalCents: total, feeBps: bps } });
      return inv!.id;
    });
    res.status(201).json(await loadInvoice(db, out));
  });

  /** Moves an invoice along its lifecycle with a row lock, so two staff members cannot double-issue or double-pay. */
  async function transition(req: Parameters<RequestHandler>[0], from: string[], to: string, apply: (tx: Queryable, inv: { id: string; organization_id: string }) => Promise<Record<string, unknown>>) {
    return db.transaction(async (tx) => {
      const [inv] = await tx.query<{ id: string; organization_id: string; status: string }>('SELECT id, organization_id, status FROM invoices WHERE id = $1 FOR UPDATE', [param(req, 'id')]);
      if (!inv) throw new AppError('NOT_FOUND', 'Resource not found.');
      if (!from.includes(inv.status)) throw new AppError('CONFLICT', `Cannot change an invoice from ${inv.status} to ${to}.`);
      const meta = await apply(tx, inv);
      await audit(tx, { actorUserId: req.auth!.userId, action: `invoice.${to}`, targetType: 'invoice', targetId: inv.id, organizationId: inv.organization_id, requestId: req.requestId, metadata: meta });
      return inv;
    });
  }

  r.post('/invoices/:id/issue', validate({ params: idParams, body: issueBody }), billing, async (req, res) => {
    const inv = await transition(req, ['draft'], 'issued', async (tx, i) => {
      const [{ n }] = await tx.query<{ n: string }>(`SELECT nextval('invoice_number_seq') AS n`) as [{ n: string }];
      const number = `INV-${String(n).padStart(6, '0')}`;
      const due = new Date(now() + req.body.dueInDays * 86_400_000).toISOString().slice(0, 10);
      await tx.query(`UPDATE invoices SET status = 'issued', number = $2, due_date = $3, issued_at = $4, updated_at = now() WHERE id = $1`, [i.id, number, due, new Date(now())]);
      return { number, dueDate: due };
    });
    const out = await loadInvoice(db, inv.id);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, inv.organization_id, 'billing.read'), {
      category: 'billing_updates', type: 'invoice.issued', title: `New invoice ${out.invoice.number}`,
      body: `Amount due: ${formatCents(out.invoice.total_cents)}. Due ${String(out.invoice.due_date).slice(0, 10)}.`, data: { invoiceId: inv.id },
    });
    res.json(out);
  });

  /** Records that payment was received outside the platform. This never charges anyone. */
  r.post('/invoices/:id/payment', validate({ params: idParams, body: payBody }), billing, async (req, res) => {
    const b = req.body as z.infer<typeof payBody>;
    const inv = await transition(req, ['issued'], 'paid', async (tx, i) => {
      await tx.query(`UPDATE invoices SET status = 'paid', paid_at = $2, payment_method = $3, payment_reference = $4, updated_at = now() WHERE id = $1`,
        [i.id, b.paidOn ? new Date(`${b.paidOn}T12:00:00Z`) : new Date(now()), b.method, b.reference]);
      return { method: b.method };
    });
    const out = await loadInvoice(db, inv.id);
    await notifyUsers(deps, await orgUserIdsWithPermission(db, inv.organization_id, 'billing.read'), {
      category: 'billing_updates', type: 'invoice.paid', title: `Payment recorded for invoice ${out.invoice.number}`, data: { invoiceId: inv.id },
    });
    res.json(out);
  });

  r.post('/invoices/:id/void', validate({ params: idParams, body: voidBody }), billing, async (req, res) => {
    const inv = await transition(req, ['draft', 'issued'], 'void', async (tx, i) => {
      await tx.query(`UPDATE invoices SET status = 'void', void_reason = $2, voided_at = now(), updated_at = now() WHERE id = $1`, [i.id, req.body.reason]);
      await tx.query('UPDATE invoice_lines SET voided = true WHERE invoice_id = $1', [i.id]);
      return { reason: req.body.reason };
    });
    const out = await loadInvoice(db, inv.id);
    if (out.invoice.number) {
      await notifyUsers(deps, await orgUserIdsWithPermission(db, inv.organization_id, 'billing.read'), {
        category: 'billing_updates', type: 'invoice.void', title: `Invoice ${out.invoice.number} was voided`, body: req.body.reason, data: { invoiceId: inv.id },
      });
    }
    res.json(out);
  });

  return r;
}

/** Read-only invoices for an organization's own billing contacts, mounted at /organizations/:orgId/billing. Invoices that were never issued (drafts, voided drafts) are never shown. */
export function orgBillingRoutes(deps: AppDeps) {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'billing.read');

  r.get('/invoices', validate({ params: orgParams }), read, async (req, res) => {
    const q = z.object({ ...paging }).parse(req.query);
    const org = req.membership!.organizationId;
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM invoices WHERE organization_id = $1 AND issued_at IS NOT NULL`, [org]);
    const rows = await db.query(
      `SELECT ${INVOICE_COLS} FROM invoices i JOIN organizations o ON o.id = i.organization_id WHERE i.organization_id = $1 AND i.issued_at IS NOT NULL
        ORDER BY i.issued_at DESC, i.id LIMIT $2 OFFSET $3`, [org, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ invoices: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/invoices/:id', validate({ params: orgInvoiceParams }), read, async (req, res) => {
    res.json(await loadInvoice(db, param(req, 'id'), req.membership!.organizationId));
  });
  return r;
}
