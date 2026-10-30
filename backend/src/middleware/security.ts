import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';
import { RateLimiter } from '../shared/rate-limit.js';

/** Baseline response headers for an API (no HTML is served). */
export const securityHeaders = (production: boolean): RequestHandler => (_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('cross-origin-resource-policy', 'same-site');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  next();
};

/**
 * CORS allowlist for the web and admin apps only. Credentials are allowed solely for those origins; any other origin
 * receives no CORS headers, so browsers will not expose responses to it. State-changing requests are also Origin-checked.
 */
export const cors = (allowed: string[]): RequestHandler => (req, res, next) => {
  const origin = req.headers.origin;
  res.vary('Origin');
  if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE');
      res.setHeader('access-control-allow-headers', 'content-type,x-file-name');
      res.setHeader('access-control-max-age', '600');
    }
  }
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
};

/** Coarse per-IP abuse limit across the whole API, on top of the stricter per-route limits. */
export const globalRateLimit = (max: number, windowMs: number, now?: () => number): RequestHandler => {
  const limiter = new RateLimiter(max, windowMs, now);
  return (req, _res, next) => {
    if (!limiter.allow(`global:${req.ip ?? 'unknown'}`)) return next(new AppError('RATE_LIMITED', 'Too many requests. Try again later.'));
    next();
  };
};
