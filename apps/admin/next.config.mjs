import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the workspace root so Next does not pick up unrelated lockfiles higher up the disk.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const apiOrigin = new URL(api).origin;

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  outputFileTracingRoot: root,
  poweredByHeader: false,
  transpilePackages: ['@bsm/ui', '@bsm/api-client', '@bsm/permissions'],
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    const csp = [`default-src 'self'`, `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`, `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data:`, `connect-src 'self' ${apiOrigin}`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`].join('; ');
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: csp }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'no-store' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ] }];
  },
};
