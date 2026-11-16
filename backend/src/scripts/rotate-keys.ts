/**
 * Re-encrypts stored secrets under new keys (runbook section 5, key compromise or routine rotation).
 *
 *   NEW_MFA_ENCRYPTION_KEY=<base64 32 bytes> NEW_FIELD_ENCRYPTION_KEY=<base64 32 bytes> npm run rotate-keys -w backend            # dry run
 *   NEW_MFA_ENCRYPTION_KEY=... NEW_FIELD_ENCRYPTION_KEY=... npm run rotate-keys -w backend -- --apply                               # writes
 *
 * Set one or both NEW_* variables. The current keys come from MFA_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEY as usual. Do this in a
 * maintenance window: right after a successful --apply, set the new values as the live MFA_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEY
 * and redeploy; until then running instances cannot read the rotated rows. Keep the old keys until the switch is confirmed, then
 * destroy them. The run is repeatable: rows already under the new key are left alone.
 */
import { loadConfig } from '../config/env.js';
import { createPgDb, createPgliteDb } from '../db/index.js';
import { rotateKeys, type KeyRotation } from '../shared/key-rotation.js';

const apply = process.argv.includes('--apply');
const config = loadConfig();

function newKey(name: string): Buffer | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const buf = Buffer.from(v, 'base64');
  if (buf.length !== 32) { console.error(`${name} must be 32 bytes, base64-encoded (openssl rand -base64 32)`); process.exit(1); }
  return buf;
}

const rotation: KeyRotation = {};
const newMfa = newKey('NEW_MFA_ENCRYPTION_KEY');
const newField = newKey('NEW_FIELD_ENCRYPTION_KEY');
if (newMfa) rotation.mfa = { from: config.mfaKey, to: newMfa };
if (newField) rotation.field = { from: config.fieldKey, to: newField };
if (!rotation.mfa && !rotation.field) { console.error('Set NEW_MFA_ENCRYPTION_KEY and/or NEW_FIELD_ENCRYPTION_KEY.'); process.exit(1); }

const db = process.env.DATABASE_URL ? createPgDb(process.env.DATABASE_URL) : await createPgliteDb('./.data/pglite');
try {
  const report = await rotateKeys(db, rotation, apply);
  for (const kind of ['mfa', 'field'] as const) {
    const r = report[kind];
    if (r) console.log(`${kind === 'mfa' ? 'mfa_methods.secret_enc' : 'credentials.number_enc'}: ${r.total} rows, ${r.rotated} ${apply ? 'rotated' : 'would rotate'}, ${r.alreadyRotated} already under the new key`);
  }
  console.log(apply
    ? 'Done. Now set the new key(s) as MFA_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEY in the environment and redeploy immediately.'
    : 'Dry run only. Re-run with --apply to write.');
} finally {
  await db.close();
}
