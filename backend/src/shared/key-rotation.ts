import type { Db, Queryable } from '../db/index.js';
import { decrypt, encrypt } from './crypto.js';

export interface KeyRotation {
  /** Rotates MFA secrets (mfa_methods.secret_enc) from `from` to `to`. */
  mfa?: { from: Buffer; to: Buffer };
  /** Rotates credential numbers (credentials.number_enc) from `from` to `to`. */
  field?: { from: Buffer; to: Buffer };
}

export interface RotationReport {
  mfa?: { total: number; rotated: number; alreadyRotated: number };
  field?: { total: number; rotated: number; alreadyRotated: number };
  applied: boolean;
}

const TARGETS = {
  mfa: { table: 'mfa_methods', column: 'secret_enc' },
  field: { table: 'credentials', column: 'number_enc' },
} as const;

/**
 * Re-encrypts every stored secret under a new key, in one transaction, after proving every row can be read with the old key (or is
 * already under the new one, so a run that was interrupted can be repeated). Nothing is written unless `apply` is true. The caller
 * must switch the environment variables to the new keys immediately after a successful apply: until then, running instances
 * cannot decrypt the rotated rows. Signed download links (also derived from the field key) issued before the switch stop working,
 * which is harmless (they last 60 seconds).
 */
export async function rotateKeys(db: Db, rotation: KeyRotation, apply: boolean): Promise<RotationReport> {
  const report: RotationReport = { applied: apply };
  await db.transaction(async (tx) => {
    for (const kind of ['mfa', 'field'] as const) {
      const keys = rotation[kind];
      if (!keys) continue;
      if (keys.from.equals(keys.to)) throw new Error(`${kind}: the new key is the same as the current key`);
      report[kind] = await rotateColumn(tx, TARGETS[kind], keys, apply);
    }
  });
  return report;
}

async function rotateColumn(tx: Queryable, t: { table: string; column: string }, keys: { from: Buffer; to: Buffer }, apply: boolean) {
  const rows = await tx.query<{ id: string; value: string | null }>(`SELECT id, ${t.column} AS value FROM ${t.table} ${apply ? 'FOR UPDATE' : ''}`);
  const out = { total: 0, rotated: 0, alreadyRotated: 0 };
  for (const row of rows) {
    if (row.value === null) continue;
    out.total += 1;
    let plain: string;
    try { plain = decrypt(keys.from, row.value); }
    catch {
      try { decrypt(keys.to, row.value); out.alreadyRotated += 1; continue; }
      catch { throw new Error(`${t.table}.${t.column} row ${row.id} decrypts with neither the current nor the new key; aborting without changes`); }
    }
    if (apply) await tx.query(`UPDATE ${t.table} SET ${t.column} = $2 WHERE id = $1`, [row.id, encrypt(keys.to, plain)]);
    out.rotated += 1;
  }
  return out;
}
