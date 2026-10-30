import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, decrypt, encrypt, totpCode, verifyTotp } from '../src/shared/crypto.js';
import { createLogger } from '../src/shared/logger.js';

describe('crypto', () => {
  it('matches the RFC 6238 SHA1 test vector', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(totpCode(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
  });

  it('accepts adjacent steps only, rejects bad input', () => {
    const secret = randomBytes(20);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step + 3), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32 and AES-GCM, and detects tampering', () => {
    const raw = randomBytes(20);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    const key = randomBytes(32);
    const enc = encrypt(key, 'secret');
    expect(decrypt(key, enc)).toBe('secret');
    const bad = Buffer.from(enc, 'base64'); bad[bad.length - 1]! ^= 1;
    expect(() => decrypt(key, bad.toString('base64'))).toThrow();
  });
});

describe('logging', () => {
  it('redacts passwords, tokens, cookies and license numbers', () => {
    process.env.LOG_LEVEL = 'info';
    let out = '';
    const log = createLogger(new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } }));
    log.info({ password: 'hunter2-pass', body: { password: 'hunter2-pass', licenseNumber: 'RN-998877' }, req: { headers: { cookie: 'bsm_session=abc123' } }, token: 'tok-xyz' }, 'x');
    delete process.env.LOG_LEVEL;
    expect(out).not.toMatch(/hunter2|RN-998877|abc123|tok-xyz/);
    expect(out).toContain('[REDACTED]');
  });
});
