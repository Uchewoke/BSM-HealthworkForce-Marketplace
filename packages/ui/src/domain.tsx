'use client';
import type { ReactNode } from 'react';
import { titleCase } from '@bsm/api-client';
import { Alert, Badge, DataTable } from './components';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/* ---------- credential status: never shows "verified" without saying how ---------- */

const CREDENTIAL_TONE: Record<string, Tone> = {
  verified: 'success', submitted: 'info', pending_review: 'info', verification_in_progress: 'info', not_submitted: 'neutral',
  needs_more_information: 'warning', unable_to_verify: 'warning', expired: 'danger', rejected: 'danger', revoked: 'danger',
};

export const CREDENTIAL_LABELS: Record<string, string> = {
  not_submitted: 'Not submitted', submitted: 'Submitted, awaiting review', pending_review: 'Pending review', verification_in_progress: 'Verification in progress',
  needs_more_information: 'More information needed', rejected: 'Rejected', expired: 'Expired', revoked: 'Revoked', unable_to_verify: 'Unable to verify',
};

/** Prefer the server-provided label; fall back to the same wording so the UI can never invent a stronger claim. */
export function credentialLabel(status: string, method?: string | null, serverLabel?: string | null): string {
  if (serverLabel) return serverLabel;
  if (status === 'verified') return method === 'primary_source' ? 'Verified with the primary source' : 'Documents reviewed (not verified with the primary source)';
  return CREDENTIAL_LABELS[status] ?? titleCase(status);
}

export function CredentialStatusBadge({ status, method, label }: { status: string; method?: string | null; label?: string | null }) {
  // A document-only review is deliberately shown as a caution, not as full verification.
  const tone: Tone = status === 'verified' && method !== 'primary_source' ? 'info' : (CREDENTIAL_TONE[status] ?? 'neutral');
  return <Badge tone={tone}>{credentialLabel(status, method, label)}</Badge>;
}

/* ---------- other statuses ---------- */

const ORG_TONE: Record<string, Tone> = { draft: 'neutral', submitted: 'info', under_review: 'info', needs_information: 'warning', approved: 'success', rejected: 'danger', suspended: 'danger' };
export const OrgStatusBadge = ({ status }: { status: string }) => <Badge tone={ORG_TONE[status] ?? 'neutral'}>{titleCase(status)}</Badge>;

const JOB_TONE: Record<string, Tone> = { draft: 'neutral', published: 'success', paused: 'warning', filled: 'info', closed: 'neutral', cancelled: 'danger' };
export const JobStatusBadge = ({ status }: { status: string }) => <Badge tone={JOB_TONE[status] ?? 'neutral'}>{titleCase(status)}</Badge>;

const APP_TONE: Record<string, Tone> = {
  submitted: 'info', under_review: 'info', shortlisted: 'info', interview_requested: 'info', interviewed: 'info', offer_sent: 'warning',
  accepted: 'success', declined: 'neutral', withdrawn: 'neutral', rejected: 'danger', cancelled: 'danger',
};
export const ApplicationStatusBadge = ({ status }: { status: string }) => <Badge tone={APP_TONE[status] ?? 'neutral'}>{titleCase(status)}</Badge>;

/* ---------- eligibility & ranking ---------- */

const OUTCOME: Record<string, { tone: Tone; text: string }> = {
  eligible: { tone: 'success', text: 'Eligible: every mandatory requirement is met' },
  pending_verification: { tone: 'info', text: 'Pending verification: not eligible until credentials are verified' },
  needs_review: { tone: 'warning', text: 'Needs review: a person must decide' },
  unavailable: { tone: 'warning', text: 'Unavailable for the selected shift(s)' },
  expired_credential: { tone: 'danger', text: 'A required credential has expired' },
  ineligible: { tone: 'danger', text: 'Not eligible: a mandatory requirement is not met' },
};

export function EligibilityBadge({ outcome }: { outcome: string }) {
  const o = OUTCOME[outcome] ?? { tone: 'neutral' as Tone, text: titleCase(outcome) };
  return <Badge tone={o.tone}>{titleCase(outcome)}</Badge>;
}

export interface EligibilityData {
  outcome: string;
  reasons: { code: string; outcome: string; message: string }[];
  requirements?: { requirement: { kind: string; credentialType: string | null; jurisdiction: string | null; description: string | null }; result: string; detail: string; verificationMethod?: string | null }[];
}

const reqName = (r: NonNullable<EligibilityData['requirements']>[number]['requirement']) =>
  r.kind === 'license' ? `${r.credentialType} license (${r.jurisdiction})` : r.kind === 'certification' ? `${r.credentialType} certification` : (r.description ?? 'Other requirement');

/** Explains an eligibility result in full: the outcome, every reason, and each mandatory requirement. Nothing is hidden. */
export function EligibilityPanel({ eligibility, heading = 'Eligibility' }: { eligibility: EligibilityData; heading?: string }) {
  const o = OUTCOME[eligibility.outcome];
  return (
    <section aria-label={heading} className="stack">
      <div className="row"><h3 style={{ margin: 0 }}>{heading}</h3><EligibilityBadge outcome={eligibility.outcome} /></div>
      {o && <p className="muted" style={{ margin: 0 }}>{o.text}.</p>}
      {eligibility.reasons.length > 0 && (
        <Alert tone={eligibility.outcome === 'eligible' ? 'info' : 'warning'} title="Why">
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{eligibility.reasons.map((r, i) => <li key={`${r.code}-${i}`}>{r.message}</li>)}</ul>
        </Alert>
      )}
      {eligibility.requirements && eligibility.requirements.length > 0 && (
        <DataTable caption="Mandatory requirements" rows={eligibility.requirements} rowKey={(r) => `${reqName(r.requirement)}-${r.result}`}
          columns={[
            { header: 'Requirement', cell: (r) => reqName(r.requirement) },
            { header: 'Result', cell: (r) => <Badge tone={r.result === 'met' ? 'success' : r.result === 'pending' ? 'info' : r.result === 'manual_review' || r.result === 'other_state_license' ? 'warning' : 'danger'}>{titleCase(r.result)}</Badge> },
            { header: 'Detail', cell: (r) => r.detail },
          ]} />
      )}
    </section>
  );
}

export interface RankingData { score: number; factors: { key: string; label: string; weight: number; value: number; contribution: number; note: string }[]; rankingVersion?: string }

export function RankingBreakdown({ ranking }: { ranking: RankingData }) {
  return (
    <section aria-label="Ranking explanation" className="stack">
      <div className="row"><h3 style={{ margin: 0 }}>Ranking among eligible candidates</h3><Badge tone="info">Score {ranking.score.toFixed(1)} / 100</Badge></div>
      <p className="muted small" style={{ margin: 0 }}>Ranking only orders candidates who already meet every mandatory requirement. It never overrides eligibility and uses only job-related factors. Weights are a starting proposal and are reviewed by BSM.</p>
      <DataTable caption="Ranking factors" rows={ranking.factors} rowKey={(f) => f.key}
        columns={[
          { header: 'Factor', cell: (f) => f.label }, { header: 'Weight', cell: (f) => `${f.weight}%` },
          { header: 'Match', cell: (f) => `${Math.round(f.value * 100)}%` }, { header: 'Points', cell: (f) => f.contribution.toFixed(1) }, { header: 'Why', cell: (f) => f.note },
        ]} />
    </section>
  );
}

export function Timeline({ items }: { items: { key: string; title: ReactNode; detail?: ReactNode; at: string }[] }) {
  return (
    <ol className="timeline">
      {items.map((i) => <li key={i.key}><strong>{i.title}</strong> <span className="muted small">· {new Date(i.at).toLocaleString()}</span>{i.detail && <div>{i.detail}</div>}</li>)}
    </ol>
  );
}
