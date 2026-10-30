import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Private object storage. Keys are server-generated UUIDs; callers never pass user-controlled paths.
 * Production should use an encrypted private bucket adapter; this interface keeps that swap local.
 */
export interface PrivateFileStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const assertKey = (key: string) => { if (!KEY.test(key)) throw new Error('invalid storage key'); };

/** Filesystem storage for local development. Point `dir` outside any web-served directory. */
export class LocalFsStorage implements PrivateFileStorage {
  constructor(private readonly dir: string) {}
  private file(key: string) { assertKey(key); return path.join(this.dir, key); }
  async put(key: string, bytes: Buffer) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(key), bytes, { mode: 0o600 });
  }
  async get(key: string) {
    try { return await readFile(this.file(key)); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  }
  async delete(key: string) { await rm(this.file(key), { force: true }); }
}

export class MemoryStorage implements PrivateFileStorage {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer) { assertKey(key); this.files.set(key, bytes); }
  async get(key: string) { assertKey(key); return this.files.get(key) ?? null; }
  async delete(key: string) { this.files.delete(key); }
}
