import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner } from '../src/integrations/malware.js';

/** A minimal clamd: reads the INSTREAM frames, answers by content, closes. */
function fakeClamd(answer: (bytes: Buffer) => string): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const header = Buffer.from('zINSTREAM\0');
        if (!buf.subarray(0, header.length).equals(header)) return;
        let off = header.length;
        const chunks: Buffer[] = [];
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          if (len === 0) { // end of stream
            const body = Buffer.concat(chunks); received.push(body);
            socket.end(`stream: ${answer(body)}\0`);
            return;
          }
          if (off + 4 + len > buf.length) return; // wait for more
          chunks.push(buf.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, received }));
  });
}

describe('ClamAV scanner', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('reports clean for OK and infected for FOUND, streaming the whole file in chunks', async () => {
    const f = await fakeClamd((b) => (b.includes('EICAR') ? 'Eicar-Test-Signature FOUND' : 'OK'));
    server = f.server;
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: f.port, chunkBytes: 7 });
    const big = Buffer.alloc(1000, 'a');
    expect(await scanner.scan(big)).toBe('clean');
    expect(f.received[0]!.equals(big)).toBe(true);
    expect(await scanner.scan(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'))).toBe('infected');
  });

  it('answers not_scanned when clamd errors or cannot be reached, never clean', async () => {
    const f = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    server = f.server;
    expect(await new ClamAvScanner({ host: '127.0.0.1', port: f.port }).scan(Buffer.from('x'))).toBe('not_scanned');
    const closed = await fakeClamd(() => 'OK');
    await new Promise<void>((r) => closed.server.close(() => r()));
    expect(await new ClamAvScanner({ host: '127.0.0.1', port: closed.port, timeoutMs: 2000 }).scan(Buffer.from('x'))).toBe('not_scanned');
  });

  it('is only built when CLAMAV_HOST is set', () => {
    expect(ClamAvScanner.fromEnv({})).toBeUndefined();
    expect(ClamAvScanner.fromEnv({ CLAMAV_HOST: 'clamd.internal', CLAMAV_PORT: '3310' })).toBeInstanceOf(ClamAvScanner);
  });
});
