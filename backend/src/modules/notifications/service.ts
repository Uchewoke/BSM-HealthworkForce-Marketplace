import { orgRoleCan, type Permission } from '@bsm/permissions';
import type { Queryable } from '../../db/index.js';
import type { CoreDeps } from '../../shared/deps.js';
import { logger } from '../../shared/logger.js';

export type Category = 'application_updates' | 'review_decisions' | 'support_updates' | 'billing_updates';
export const CATEGORIES: Category[] = ['application_updates', 'review_decisions', 'support_updates', 'billing_updates'];

export interface NotificationInput {
  category: Category; type: string; title: string;
  /** In-app only; may mention applicant/job names. Emails use the title alone. */
  body?: string; data?: Record<string, unknown>;
}

/** Active members of an organization whose role grants the permission. */
export async function orgUserIdsWithPermission(q: Queryable, orgId: string, permission: Permission): Promise<string[]> {
  const rows = await q.query<{ user_id: string; role: string }>(
    `SELECT user_id, role FROM organization_members WHERE organization_id = $1 AND status = 'active'`, [orgId]);
  return rows.filter((r) => orgRoleCan(r.role, permission)).map((r) => r.user_id);
}

/**
 * Creates one in-app notification per recipient, then makes a best-effort email attempt for recipients whose preference
 * allows it. The email outcome is recorded honestly: 'not_delivered' when no provider is configured, 'failed' on error.
 * A failure here never breaks the action that triggered the notification.
 */
export async function notifyUsers(deps: Pick<CoreDeps, 'db' | 'email'>, userIds: string[], n: NotificationInput): Promise<void> {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    try {
      const [row] = await deps.db.query<{ id: string }>(
        `INSERT INTO notifications (user_id, category, type, title, body, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
        [userId, n.category, n.type, n.title, n.body ?? null, JSON.stringify(n.data ?? {})]);
      const [pref] = await deps.db.query<{ email_enabled: boolean }>(
        'SELECT email_enabled FROM notification_preferences WHERE user_id = $1 AND category = $2', [userId, n.category]);
      if (pref && !pref.email_enabled) continue; // email_status stays 'skipped'
      const [user] = await deps.db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND status = 'active'`, [userId]);
      if (!user) continue;
      let status: 'sent' | 'not_delivered' | 'failed';
      try { status = (await deps.email.send({ to: user.email, template: 'notification', title: n.title })).status; }
      catch (e) { logger.warn({ err: (e as Error).message }, 'notification email failed'); status = 'failed'; }
      await deps.db.query('UPDATE notifications SET email_status = $2 WHERE id = $1', [row!.id, status]);
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'notification failed');
    }
  }
}
