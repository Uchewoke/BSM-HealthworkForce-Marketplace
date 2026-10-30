import type { Queryable } from '../db/index.js';

/**
 * Builds `SET col = $n, ...` from an allowlist map (camelCase input key -> column). Only mapped keys are used,
 * so request bodies can never reach arbitrary columns. Returns null if nothing to update.
 */
export function buildSet(columns: Record<string, string>, input: Record<string, unknown>, startIndex = 1) {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(columns)) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      parts.push(`${col} = $${startIndex + values.length - 1}`);
    }
  }
  return parts.length ? { sql: parts.join(', '), values } : null;
}

/** INSERT with allowlisted columns plus fixed (server-controlled) values such as the owner id. */
export function buildInsert(columns: Record<string, string>, input: Record<string, unknown>, fixed: Record<string, unknown>) {
  const cols: string[] = Object.keys(fixed);
  const values: unknown[] = Object.values(fixed);
  for (const [key, col] of Object.entries(columns)) {
    if (input[key] !== undefined) { cols.push(col); values.push(input[key]); }
  }
  return { sql: `(${cols.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`, values };
}

/** Full replacement of allowlisted columns (missing optional keys become NULL). */
export function buildReplace(columns: Record<string, string>, input: Record<string, unknown>, startIndex: number) {
  const values = Object.keys(columns).map((k) => input[k] ?? null);
  return { sql: Object.values(columns).map((c, i) => `${c} = $${startIndex + i}`).join(', '), values };
}

export async function updateRow(
  q: Queryable, table: string, columns: Record<string, string>, input: Record<string, unknown>,
  where: { id: string; organizationId: string }, returning: string,
) {
  const set = buildSet(columns, input, 3);
  if (!set) return null;
  const rows = await q.query(
    `UPDATE ${table} SET ${set.sql}, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING ${returning}`,
    [where.id, where.organizationId, ...set.values]);
  return rows[0] ?? null;
}
