import { createHmac, timingSafeEqual } from 'node:crypto';
import { platformRoleCan } from '@bsm/permissions';
import type { Db } from '../../db/index.js';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../../shared/deps.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_CREDENTIAL = 5;
export const DOWNLOAD_URL_TTL_MS = 60_000;
export const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

const SIGNATURES: Record<AllowedType, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

/** The declared type must be allowed AND the leading bytes must match it, so a renamed file is rejected. */
export function contentMatchesType(bytes: Buffer, type: string): type is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(type) && SIGNATURES[type as AllowedType](bytes);
}

/** Display name only: never used to build a path. */
export function sanitizeFileName(raw: string | undefined): string {
  let name = 'document';
  try { name = decodeURIComponent(raw ?? '') || name; } catch { /* keep default */ }
  name = name.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 100).trim();
  return name || 'document';
}

const signingKey = (config: AppConfig) => createHmac('sha256', config.fieldKey).update('file-access-v1').digest();

/** Short-lived, user-bound download token: base64url(payload).signature */
export function signDownloadToken(config: AppConfig, p: { documentId: string; userId: string }, nowMs: number): { token: string; expiresAt: Date } {
  const exp = nowMs + DOWNLOAD_URL_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ d: p.documentId, u: p.userId, e: exp })).toString('base64url');
  const sig = createHmac('sha256', signingKey(config)).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp) };
}

export function verifyDownloadToken(config: AppConfig, token: string, nowMs: number): { documentId: string; userId: string } {
  const bad = () => new AppError('FORBIDDEN', 'This download link is invalid or has expired.');
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw bad();
  const expected = createHmac('sha256', signingKey(config)).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  let parsed: { d?: string; u?: string; e?: number };
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!parsed.d || !parsed.u || typeof parsed.e !== 'number' || parsed.e < nowMs) throw bad();
  return { documentId: parsed.d, userId: parsed.u };
}

export interface DocumentRow {
  id: string; credential_id: string; professional_id: string; storage_key: string; original_name: string;
  content_type: string; size_bytes: number; owner_user_id: string;
}

/**
 * Who may read a credential document: the professional who owns it, or a platform reviewer with credential-review
 * permission and a verified MFA session. Facilities and other professionals get 404 (no explicit business-purpose
 * access grant exists yet). Evaluated at link creation AND at download.
 */
export async function authorizeDocumentAccess(db: Db, auth: AuthContext, documentId: string): Promise<{ doc: DocumentRow; asReviewer: boolean }> {
  const [doc] = await db.query<DocumentRow>(
    `SELECT d.id, d.credential_id, d.professional_id, d.storage_key, d.original_name, d.content_type, d.size_bytes, p.user_id AS owner_user_id
       FROM credential_documents d JOIN professionals p ON p.id = d.professional_id WHERE d.id = $1`, [documentId]);
  if (!doc) throw new AppError('NOT_FOUND', 'Resource not found.');
  if (doc.owner_user_id === auth.userId) return { doc, asReviewer: false };
  if (auth.platformRole && auth.mfaVerified && platformRoleCan(auth.platformRole, 'admin.credential_review')) return { doc, asReviewer: true };
  throw new AppError('NOT_FOUND', 'Resource not found.');
}
