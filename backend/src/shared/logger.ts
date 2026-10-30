import { pino, type DestinationStream } from 'pino';

export const redactPaths = [
  'password', '*.password', 'token', '*.token', 'authorization', '*.authorization',
  'req.headers.authorization', 'req.headers.cookie', 'cookie', '*.cookie',
  'licenseNumber', '*.licenseNumber', 'sessionToken', '*.sessionToken', 'secret', '*.secret', 'totpCode', '*.totpCode',
];

/** Structured logger. Sensitive fields are redacted so secrets never reach logs. */
export const createLogger = (dest?: DestinationStream) =>
  pino(
    {
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
      redact: { paths: redactPaths, censor: '[REDACTED]' },
    },
    dest,
  );

export const logger = createLogger();
