import type { Queryable } from '../../db/index.js';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  organizationId?: string | null;
  requestId?: string;
  /** Keep metadata minimal: no passwords, tokens, or document contents. */
  metadata?: Record<string, unknown>;
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, organization_id, request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [e.actorUserId ?? null, e.action, e.targetType ?? null, e.targetId ?? null,
     e.organizationId ?? null, e.requestId ?? null, JSON.stringify(e.metadata ?? {})],
  );
}
