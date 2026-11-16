import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Private object storage. Keys are server-generated UUIDs; callers never pass user-controlled paths.
 * Production uses the S3-compatible adapter against a private, encrypted bucket; this interface keeps that swap local.
 */
export interface PrivateFileStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const assertKey = (key: string) => { if (!KEY.test(key)) throw new Error('invalid storage key'); };

/** Filesystem storage for local development. Point `dir` outside any web-served directory. Refused in production. */
export class LocalFsStorage implements PrivateFileStorage {
  constructor(private readonly dir: string, nodeEnv = 'development') {
    if (nodeEnv === 'production') throw new Error('LocalFsStorage cannot be used in production');
  }
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

/** The subset of the S3 client this adapter uses, so tests can substitute one. */
export interface S3Like { send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<any> }

export interface S3StorageOptions {
  bucket: string;
  /** Objects live under this prefix inside the bucket (default "credential-documents/"). */
  prefix?: string;
  /** Server-side encryption header to send on every put. Leave unset when the bucket enforces default encryption (recommended). */
  sse?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
}

/**
 * Any S3-compatible private bucket: AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage (S3 endpoint), MinIO. The bucket must
 * block public access; every object is written with a server-generated key and read back only through the API's own
 * authorization. Objects are never served from the bucket URL.
 */
export class S3PrivateStorage implements PrivateFileStorage {
  private readonly prefix: string;
  constructor(private readonly client: S3Like, private readonly opts: S3StorageOptions) {
    this.prefix = (opts.prefix ?? 'credential-documents/').replace(/^\/+/, '');
  }

  /**
   * STORAGE_BUCKET is required. STORAGE_REGION (default us-east-1), STORAGE_ENDPOINT (for R2/B2/Supabase/MinIO), STORAGE_FORCE_PATH_STYLE,
   * STORAGE_PREFIX, STORAGE_SSE and credentials from STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY (or the AWS default chain).
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): S3PrivateStorage | undefined {
    if (!env.STORAGE_BUCKET) return undefined;
    const config: S3ClientConfig = { region: env.STORAGE_REGION || 'us-east-1' };
    if (env.STORAGE_ENDPOINT) config.endpoint = env.STORAGE_ENDPOINT;
    if (env.STORAGE_FORCE_PATH_STYLE === 'true') config.forcePathStyle = true;
    if (env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY) {
      config.credentials = { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY };
    }
    const sse = env.STORAGE_SSE === 'AES256' || env.STORAGE_SSE === 'aws:kms' ? env.STORAGE_SSE : undefined;
    return new S3PrivateStorage(new S3Client(config), { bucket: env.STORAGE_BUCKET, prefix: env.STORAGE_PREFIX, sse, kmsKeyId: env.STORAGE_KMS_KEY_ID });
  }

  private objectKey(key: string) { assertKey(key); return `${this.prefix}${key}`; }

  async put(key: string, bytes: Buffer) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.opts.bucket, Key: this.objectKey(key), Body: bytes, ContentLength: bytes.length,
      ContentType: 'application/octet-stream', // the real type lives in the database; the bucket never serves it anyway
      ...(this.opts.sse ? { ServerSideEncryption: this.opts.sse } : {}),
      ...(this.opts.sse === 'aws:kms' && this.opts.kmsKeyId ? { SSEKMSKeyId: this.opts.kmsKeyId } : {}),
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) }));
  }
}
