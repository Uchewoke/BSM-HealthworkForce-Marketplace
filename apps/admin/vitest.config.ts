import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Kept even while admin has no tests: without a config here, vitest searches parent folders and loads whatever it finds outside the repo.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: { environment: 'jsdom', globals: true, css: false, include: ['tests/**/*.test.{ts,tsx}'], testTimeout: 20_000 },
});
