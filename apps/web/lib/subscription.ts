import { money } from '@/lib/billing';

export const SUBSCRIPTION_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  incomplete: 'neutral', trialing: 'info', active: 'success', past_due: 'warning', unpaid: 'danger', canceled: 'neutral', paused: 'neutral',
};

export const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused'];

export interface Plan {
  id: string; code: string; tier: string; name: string; description: string; billingInterval: 'month' | 'year'; priceAmount: number;
  trialDays: number; purchasable: boolean; entitlements: Record<string, boolean | number | string | null>;
}

export const priceLabel = (p: Pick<Plan, 'priceAmount' | 'billingInterval'>) => `${money(p.priceAmount)} / ${p.billingInterval === 'year' ? 'year' : 'month'}`;

const LIMIT_LABELS: Record<string, string> = {
  'talent_search.monthly_limit': 'talent searches per month', 'active_locations.limit': 'active locations',
  'agency_roster.limit': 'roster members', 'agency_submissions.monthly_limit': 'candidate submissions per month',
};
const FEATURE_LABELS: Record<string, string> = {
  'matching.enabled': 'Workforce matching', 'talent_search.enabled': 'Talent search', 'workforce_analytics.enabled': 'Workforce analytics',
  'priority_support.enabled': 'Priority support', 'api_access.enabled': 'API access',
};
export const usageLabel = (key: string) => LIMIT_LABELS[key] ?? key;

/** Human-readable feature lines for a plan card: included features first, then limits ("Unlimited" for a contracted amount). */
export function featureLines(e: Plan['entitlements']): string[] {
  const out: string[] = [];
  for (const [k, label] of Object.entries(FEATURE_LABELS)) {
    if (e[k] === true) out.push(k === 'workforce_analytics.enabled' && typeof e['workforce_analytics.level'] === 'string' ? `${label} (${e['workforce_analytics.level']})` : label);
  }
  for (const [k, label] of Object.entries(LIMIT_LABELS)) {
    if (k in e) out.push(e[k] === null ? `Unlimited ${label}` : `${e[k]} ${label}`);
  }
  return out;
}
