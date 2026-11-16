import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the workspace root so Next does not pick up unrelated lockfiles higher up the disk.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// In production the API is a separate origin (a DigitalOcean Droplet; set NEXT_PUBLIC_API_URL=https://api.<domain>/api/v1 on Vercel).
// The defaults below cover a same-origin /api rewrite on Vercel and the local dev server; `env` inlines the result for the browser.
const api = process.env.NEXT_PUBLIC_API_URL ?? (process.env.VERCEL ? '/api/v1' : 'http://localhost:4000/api/v1');
const apiOrigin = api.startsWith('/') ? null : new URL(api).origin; // same-origin needs nothing beyond 'self' in the CSP

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Lets a second copy of the app be built beside the normal one (for example to test against another API) without sharing .next. (Next rewrites tsconfig.json and next-env.d.ts for the extra folder: discard those changes afterwards.)
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: root,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_API_URL: api },
  transpilePackages: ['@bsm/ui', '@bsm/api-client', '@bsm/permissions'],
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    // Next.js needs inline scripts/styles; a nonce-based CSP is a hardening follow-up.
    const csp = [`default-src 'self'`, `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`, `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data:`, `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`].join('; ');
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: csp }, { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};
