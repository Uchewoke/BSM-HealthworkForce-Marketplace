import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each file boots its own embedded database and migrates it (about 30s alone on a 4-core laptop, far longer when files run in
  // parallel), so the limits are generous: a timeout here should mean a hang, not a slow machine.
  test: { environment: 'node', testTimeout: 180_000, hookTimeout: 180_000 },
});
