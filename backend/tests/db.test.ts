import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgliteDb, migrate } from '../src/db/index.js';

describe('embedded database on disk', () => {
  it('starts on a clean checkout where the parent data folder does not exist yet, and persists across restarts', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'bsm-pglite-'));
    const dir = path.join(base, 'does-not-exist-yet', 'nested', 'pglite');
    try {
      const first = await createPgliteDb(dir);
      expect((await migrate(first)).length).toBeGreaterThan(0);
      await first.query(`INSERT INTO professions (code, name) VALUES ('probe', 'Probe')`);
      await first.close();

      const second = await createPgliteDb(dir);
      expect(await migrate(second)).toEqual([]); // nothing re-applied
      expect((await second.query(`SELECT 1 FROM professions WHERE code = 'probe'`)).length).toBe(1);
      await second.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
