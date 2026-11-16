import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3PrivateStorage, type S3Like } from '../src/integrations/storage.js';

/** Records commands and keeps objects in memory, answering like S3 would. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const commands: { name: string; input: any }[] = [];
  const client: S3Like = {
    async send(cmd) {
      commands.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof PutObjectCommand) { objects.set(cmd.input.Key!, Buffer.from(cmd.input.Body as Uint8Array)); return {}; }
      if (cmd instanceof GetObjectCommand) {
        const b = objects.get(cmd.input.Key!);
        if (!b) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
        return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
      }
      if (cmd instanceof DeleteObjectCommand) { objects.delete(cmd.input.Key!); return {}; }
      throw new Error('unexpected command');
    },
  };
  return { client, objects, commands };
}

describe('S3 private storage', () => {
  it('round-trips bytes under a prefixed, server-generated key', async () => {
    const s3 = fakeS3();
    const storage = new S3PrivateStorage(s3.client, { bucket: 'bsm-private', prefix: 'docs/' });
    const key = randomUUID();
    await storage.put(key, Buffer.from('%PDF-1.4 hello'));
    expect(s3.commands[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'bsm-private', Key: `docs/${key}`, ContentType: 'application/octet-stream' } });
    expect(s3.commands[0]!.input.ServerSideEncryption).toBeUndefined();
    expect((await storage.get(key))?.toString()).toBe('%PDF-1.4 hello');
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });

  it('returns null for a missing object instead of throwing', async () => {
    const storage = new S3PrivateStorage(fakeS3().client, { bucket: 'b' });
    expect(await storage.get(randomUUID())).toBeNull();
  });

  it('rejects keys that are not UUIDs, so a path can never be smuggled in', async () => {
    const s3 = fakeS3();
    const storage = new S3PrivateStorage(s3.client, { bucket: 'b' });
    await expect(storage.put('../../etc/passwd', Buffer.from('x'))).rejects.toThrow(/invalid storage key/);
    await expect(storage.get('not-a-uuid')).rejects.toThrow(/invalid storage key/);
    expect(s3.commands).toHaveLength(0);
  });

  it('sends the encryption header when asked to', async () => {
    const s3 = fakeS3();
    const storage = new S3PrivateStorage(s3.client, { bucket: 'b', sse: 'aws:kms', kmsKeyId: 'arn:key' });
    await storage.put(randomUUID(), Buffer.from('x'));
    expect(s3.commands[0]!.input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'arn:key' });
  });

  it('is built from the environment only when a bucket is named', () => {
    expect(S3PrivateStorage.fromEnv({})).toBeUndefined();
    expect(S3PrivateStorage.fromEnv({ STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_SECRET_ACCESS_KEY: 's' })).toBeInstanceOf(S3PrivateStorage);
  });
});
