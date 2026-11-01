import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requirePlatformPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { FEATURE_LABELS, GATED_FEATURES } from './service.js';

const params = z.object({ feature: z.enum(GATED_FEATURES) });
const body = z.object({
  signedOff: z.boolean(),
  /** Where the review is recorded (a memo, ticket or document id). Required to sign off, so there is always something to point at. */
  reference: z.string().trim().min(3).max(300).optional(),
  note: z.string().trim().max(1000).optional(),
}).refine((b) => !b.signedOff || !!b.reference, { message: 'A reference to the legal review is required to sign off.', path: ['reference'] });

/**
 * Staff record that legal review is complete for a gated feature, mounted at /admin/legal-signoffs. Super admins only
 * (settings_manage). This does not make anything lawful: it records who said the review is done, when, and where it is written down.
 */
export function adminLegalRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const manage = requirePlatformPermission('admin.settings_manage');

  r.get('/', manage, async (_req, res) => {
    const rows = await db.query<any>(
      `SELECT l.feature, l.signed_off, l.reference, l.note, l.signed_off_at, u.full_name AS signed_off_by_name
         FROM legal_signoffs l LEFT JOIN users u ON u.id = l.signed_off_by ORDER BY l.feature`);
    res.json({ signoffs: rows.map((x) => ({ feature: x.feature, label: FEATURE_LABELS[x.feature as keyof typeof FEATURE_LABELS], signedOff: x.signed_off, reference: x.reference, note: x.note, signedOffAt: x.signed_off_at, signedOffBy: x.signed_off_by_name })) });
  });

  r.put('/:feature', validate({ params, body }), manage, async (req, res) => {
    const feature = req.params.feature as (typeof GATED_FEATURES)[number];
    const b = req.body as z.infer<typeof body>;
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE legal_signoffs SET signed_off = $2, reference = $3, note = $4, signed_off_by = $5, signed_off_at = CASE WHEN $2 THEN now() ELSE signed_off_at END, updated_at = now() WHERE feature = $1`,
        [feature, b.signedOff, b.signedOff ? b.reference : (b.reference ?? null), b.note ?? null, req.auth!.userId]);
      if (!b.signedOff) {
        // Switching a feature off must also stop what is in flight, not just block new activity.
        if (feature === 'float_pool') {
          await tx.query(`UPDATE float_requests SET status = 'withdrawn', failure_reason = 'The regional float pool was switched off', responded_at = now() WHERE status = 'pending'`);
        }
      }
      await audit(tx, {
        actorUserId: req.auth!.userId, action: b.signedOff ? 'legal.signoff_recorded' : 'legal.signoff_revoked', targetType: 'legal_signoff', targetId: feature,
        requestId: req.requestId, metadata: { feature, reference: b.reference ?? null },
      });
    });
    if (!(await db.query('SELECT 1 FROM legal_signoffs WHERE feature = $1', [feature]))[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    res.json({ feature, signedOff: b.signedOff });
  });

  return r;
}
