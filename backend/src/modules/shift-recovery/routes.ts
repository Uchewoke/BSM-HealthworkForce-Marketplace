import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { audit } from '../audit/service.js';
import { runRecoveryUnderLease } from './scheduler.js';
import { isSignedOff, requireSignedOff } from '../legal/service.js';
import { loadSettings, startShiftRecovery, stopShiftRecovery } from './service.js';

const orgParams = z.object({ orgId: z.uuid() });
const shiftParams = z.object({ orgId: z.uuid(), shiftId: z.uuid() });
const settingsBody = z.object({
  enabled: z.boolean(),
  maxOutreach: z.number().int().min(1).max(25),
  offerHours: z.number().int().min(1).max(72),
  escalateHours: z.number().int().min(2).max(336),
  minLeadHours: z.number().int().min(0).max(48),
  includeFloatPool: z.boolean(),
});

/** Facility controls for unfilled-shift recovery, mounted at /organizations/:orgId/shift-recovery. */
export function shiftRecoveryRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = () => new Date((deps.now ?? Date.now)());
  const runLimiter = new RateLimiter(10, 3600_000, deps.now ?? Date.now, deps.limits);
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'applications.read');
  const manage = requireOrgPermission(deps, 'applications.manage');
  const orgOf = (req: Request) => req.membership!.organizationId;

  r.get('/settings', validate({ params: orgParams }), read, async (req, res) => {
    const s = await loadSettings(db, orgOf(req));
    const [who] = s.enabled_by ? await db.query<{ full_name: string; active: boolean }>(
      `SELECT u.full_name, (u.status = 'active' AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = $2 AND m.user_id = u.id AND m.status = 'active')) AS active FROM users u WHERE u.id = $1`, [s.enabled_by, orgOf(req)]) : [];
    const [participates] = await db.query('SELECT 1 FROM exchange_participants WHERE organization_id = $1 AND status = $2', [orgOf(req), 'active']);
    res.json({
      available: await isSignedOff(db, 'shift_recovery'),
      settings: { enabled: s.enabled, maxOutreach: s.max_outreach, offerHours: s.offer_hours, escalateHours: s.escalate_hours, minLeadHours: s.min_lead_hours, includeFloatPool: s.include_float_pool },
      enabledBy: who?.full_name ?? null,
      // Automatic offers are made on the approver's behalf; if they have left, recovery pauses until someone re-approves it.
      approverActive: s.enabled ? !!who?.active : null,
      participatesInExchange: !!participates,
    });
  });

  r.put('/settings', validate({ params: orgParams, body: settingsBody }), requireOrgPermission(deps, 'org.update'), requireApprovedOrg(deps), async (req, res) => {
    const b = req.body as z.infer<typeof settingsBody>;
    if (b.enabled) await requireSignedOff(db, 'shift_recovery'); // switching it off is always allowed
    const before = await loadSettings(db, orgOf(req));
    const becomingEnabled = b.enabled && (!before.enabled || !before.enabled_by);
    await db.query(
      `INSERT INTO shift_recovery_settings (organization_id, enabled, enabled_by, max_outreach, offer_hours, escalate_hours, min_lead_hours, include_float_pool)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, enabled_by = CASE WHEN $9 THEN EXCLUDED.enabled_by WHEN EXCLUDED.enabled THEN shift_recovery_settings.enabled_by ELSE NULL END,
         max_outreach = EXCLUDED.max_outreach, offer_hours = EXCLUDED.offer_hours, escalate_hours = EXCLUDED.escalate_hours, min_lead_hours = EXCLUDED.min_lead_hours,
         include_float_pool = EXCLUDED.include_float_pool, updated_at = now()`,
      [orgOf(req), b.enabled, b.enabled ? req.auth!.userId : null, b.maxOutreach, b.offerHours, b.escalateHours, b.minLeadHours, b.includeFloatPool, becomingEnabled]);
    await audit(db, { actorUserId: req.auth!.userId, action: b.enabled ? (becomingEnabled ? 'shift_recovery.enabled' : 'shift_recovery.settings_changed') : 'shift_recovery.disabled', targetType: 'organization', targetId: orgOf(req), organizationId: orgOf(req), requestId: req.requestId, metadata: { ...b } });
    res.json({ settings: b });
  });

  /** Shifts in recovery: what was tried, what is waiting, and anything that needs the facility's attention. */
  r.get('/', validate({ params: orgParams }), read, async (req, res) => {
    const rows = await db.query<any>(
      `SELECT sr.shift_id, sr.status, sr.started_by, sr.last_run_at, sr.escalated_at, sr.escalation, s.starts_at, s.ends_at, s.positions, s.hourly_rate_cents, j.title,
              s.positions - (SELECT count(*) FROM assignments a WHERE a.shift_id = s.id AND a.status IN ('confirmed','completed')) AS open_positions,
              (SELECT count(*) FROM shift_offers o WHERE o.shift_id = s.id AND o.status = 'sent' AND o.expires_at > $2) + (SELECT count(*) FROM float_requests f WHERE f.shift_id = s.id AND f.status = 'pending' AND f.expires_at > $2) AS waiting,
              (SELECT count(*) FROM shift_offers o WHERE o.shift_id = s.id AND o.origin = 'recovery') + (SELECT count(*) FROM float_requests f WHERE f.shift_id = s.id AND f.origin = 'recovery') AS automatic_outreach
         FROM shift_recovery sr JOIN shifts s ON s.id = sr.shift_id JOIN jobs j ON j.id = s.job_id
        WHERE sr.organization_id = $1 AND s.starts_at > $2 - interval '1 day'
        ORDER BY (sr.escalated_at IS NOT NULL AND sr.status = 'active') DESC, s.starts_at LIMIT 100`, [orgOf(req), now()]);
    res.json({ shifts: rows.map((x) => ({ ...x, open_positions: Number(x.open_positions), waiting: Number(x.waiting), automatic_outreach: Number(x.automatic_outreach) })) });
  });

  r.post('/shifts/:shiftId/start', validate({ params: shiftParams }), manage, requireApprovedOrg(deps), async (req, res) => {
    await startShiftRecovery(db, { organizationId: orgOf(req), shiftId: param(req, 'shiftId'), userId: req.auth!.userId, requestId: req.requestId });
    res.status(202).json({ started: true });
  });

  r.post('/shifts/:shiftId/stop', validate({ params: shiftParams }), manage, async (req, res) => {
    await stopShiftRecovery(db, { organizationId: orgOf(req), shiftId: param(req, 'shiftId'), userId: req.auth!.userId, requestId: req.requestId });
    res.status(204).end();
  });

  /** "Check now": runs recovery for this organization immediately instead of waiting for the next scheduled pass. */
  r.post('/run', validate({ params: orgParams }), manage, requireApprovedOrg(deps), async (req, res) => {
    await requireSignedOff(db, 'shift_recovery');
    if (!(await runLimiter.allow(`recovery-run:${orgOf(req)}`))) throw new AppError('RATE_LIMITED', 'You have run this a lot in the last hour. It also runs automatically every few minutes.');
    const settings = await loadSettings(db, orgOf(req));
    if (!settings.enabled) throw new AppError('CONFLICT', 'Turn on unfilled-shift recovery in the settings first.');
    const summary = await runRecoveryUnderLease(deps, { now: now(), organizationId: orgOf(req), requestId: req.requestId });
    if (!summary) throw new AppError('CONFLICT', 'A check is already running. Try again in a moment.');
    res.json({ summary });
  });

  return r;
}
