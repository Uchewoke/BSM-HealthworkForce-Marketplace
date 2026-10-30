import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

const BUCKETS_MS = [25, 100, 500, 2000] as const;

/** Small in-process request metrics. Per-process only: aggregate in your monitoring system when running several instances. */
export class Metrics {
  readonly startedAt = Date.now();
  total = 0;
  readonly byStatusClass: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  readonly latency: Record<string, number> = Object.fromEntries([...BUCKETS_MS.map((b) => [`le_${b}ms`, 0]), ['gt_2000ms', 0]]);
  rateLimited = 0;

  record(status: number, ms: number) {
    this.total += 1;
    const cls = `${Math.floor(status / 100)}xx`;
    this.byStatusClass[cls] = (this.byStatusClass[cls] ?? 0) + 1;
    if (status === 429) this.rateLimited += 1;
    const bucket = BUCKETS_MS.find((b) => ms <= b);
    this.latency[bucket ? `le_${bucket}ms` : 'gt_2000ms'] = (this.latency[bucket ? `le_${bucket}ms` : 'gt_2000ms'] ?? 0) + 1;
  }

  snapshot() {
    const errors = this.byStatusClass['5xx'] ?? 0;
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000), requests: this.total, byStatusClass: this.byStatusClass,
      latency: this.latency, rateLimited: this.rateLimited, errorRate: this.total ? Math.round((errors / this.total) * 10_000) / 10_000 : 0,
    };
  }
}

/**
 * One structured line per request. Deliberately logs only the matched route pattern, method, status, duration, request id
 * and user id: never bodies, query strings, headers, cookies or tokens.
 */
export const requestLogger = (log: Logger, metrics: Metrics): RequestHandler => (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.record(res.statusCode, ms);
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    const fields = { requestId: req.requestId, method: req.method, route, status: res.statusCode, durationMs: Math.round(ms), userId: req.auth?.userId };
    if (res.statusCode >= 500) log.error(fields, 'request failed');
    else if (res.statusCode === 429) log.warn(fields, 'request rate limited');
    else log.info(fields, 'request');
  });
  next();
};
