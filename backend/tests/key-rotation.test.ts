import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/shared/crypto.js';
import { rotateKeys } from '../src/shared/key-rotation.js';
import { makeTestApp } from './helpers.js';

describe('key rotation', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let mfaId: string; let credId: string;
  const newMfa = randomBytes(32); const newField = randomBytes(32);

  beforeAll(async () => {
    t = await makeTestApp();
    const { db, config } = t.deps;
    const userId = await t.svc.createUser({ email: 'rot@example.com', password: 'correct horse battery staple', fullName: 'Rot', verified: true });
    const [m] = await db.query<{ id: string }>(
      `INSERT INTO mfa_methods (user_id, type, secret_enc, confirmed_at) VALUES ($1, 'totp', $2, now()) RETURNING id`, [userId, encrypt(config.mfaKey, 'JBSWY3DPEHPK3PXP')]);
    mfaId = m!.id;
    const [prof] = await db.query<{ id: string }>(`SELECT id FROM professions LIMIT 1`);
    const [p] = await db.query<{ id: string }>(`INSERT INTO professionals (user_id, profession_id) VALUES ($1, $2) RETURNING id`, [userId, prof!.id]);
    const [c] = await db.query<{ id: string }>(
      `INSERT INTO credentials (professional_id, kind, credential_type, jurisdiction, number_enc, number_last4) VALUES ($1, 'license', 'RN', 'TX', $2, '6789') RETURNING id`, [p!.id, encrypt(config.fieldKey, 'RN-123456789')]);
    credId = c!.id;
    await db.query(`INSERT INTO credentials (professional_id, kind, credential_type) VALUES ($1, 'certification', 'BLS')`, [p!.id]); // no number: untouched
  });
  afterAll(() => t.db.close());

  const read = async () => {
    const [m] = await t.db.query<{ secret_enc: string }>('SELECT secret_enc FROM mfa_methods WHERE id = $1', [mfaId]);
    const [c] = await t.db.query<{ number_enc: string }>('SELECT number_enc FROM credentials WHERE id = $1', [credId]);
    return { mfa: m!.secret_enc, cred: c!.number_enc };
  };

  it('dry run reports what it would do and changes nothing', async () => {
    const before = await read();
    const r = await rotateKeys(t.db, { mfa: { from: t.deps.config.mfaKey, to: newMfa }, field: { from: t.deps.config.fieldKey, to: newField } }, false);
    expect(r).toEqual({ applied: false, mfa: { total: 1, rotated: 1, alreadyRotated: 0 }, field: { total: 1, rotated: 1, alreadyRotated: 0 } });
    expect(await read()).toEqual(before);
  });

  it('refuses when a row cannot be read with the current key, leaving everything untouched', async () => {
    const before = await read();
    await expect(rotateKeys(t.db, { mfa: { from: randomBytes(32), to: newMfa } }, true)).rejects.toThrow(/neither the current nor the new key/);
    expect(await read()).toEqual(before);
  });

  it('refuses a rotation to the same key', async () => {
    await expect(rotateKeys(t.db, { field: { from: t.deps.config.fieldKey, to: t.deps.config.fieldKey } }, true)).rejects.toThrow(/same as the current key/);
  });

  it('applies both rotations in one transaction and is repeatable', async () => {
    const r = await rotateKeys(t.db, { mfa: { from: t.deps.config.mfaKey, to: newMfa }, field: { from: t.deps.config.fieldKey, to: newField } }, true);
    expect(r.applied).toBe(true);
    const after = await read();
    expect(decrypt(newMfa, after.mfa)).toBe('JBSWY3DPEHPK3PXP');
    expect(decrypt(newField, after.cred)).toBe('RN-123456789');
    expect(() => decrypt(t.deps.config.fieldKey, after.cred)).toThrow();
    // Running again with the old "current" key sees every row already rotated and writes nothing.
    const again = await rotateKeys(t.db, { field: { from: t.deps.config.fieldKey, to: newField } }, true);
    expect(again.field).toEqual({ total: 1, rotated: 0, alreadyRotated: 1 });
    expect((await read()).cred).toBe(after.cred);
  });
});
