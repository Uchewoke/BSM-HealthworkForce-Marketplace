import type { PlatformRole } from '@bsm/permissions';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import type { Db } from '../db/index.js';
import type { BillingProvider } from '../integrations/billing.js';
import type { AssistantProvider } from '../integrations/assistant.js';
import type { EmailSender } from '../integrations/email.js';
import type { MalwareScanner } from '../integrations/malware.js';
import type { PrivateFileStorage } from '../integrations/storage.js';
import type { RateLimitStore } from './rate-limit.js';

export interface CoreDeps {
  db: Db;
  config: AppConfig;
  email: EmailSender;
  now?: () => number;
  /** Shared rate-limit counters (Redis). Unset: per-process memory, which is only correct for a single long-running server. */
  limits?: RateLimitStore;
}

export interface AppDeps extends CoreDeps {
  storage: PrivateFileStorage;
  scanner: MalwareScanner;
  /** The AI assistant provider. Unconfigured (no API key) means the feature reports itself unavailable. */
  assistant: AssistantProvider;
  /** The subscription payment provider (Stripe). Unconfigured means checkout and webhooks report themselves unavailable. */
  billing?: BillingProvider;
  /** Defaults to the shared redacting logger. Tests inject one to verify nothing sensitive is logged. */
  logger?: Logger;
  /** Per-IP limit across the whole API. Defaults to 600 requests per 5 minutes. */
  globalLimit?: { max: number; windowMs: number };
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  platformRole: PlatformRole | null;
  mfaVerified: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    membership?: { organizationId: string; role: string };
  }
}
