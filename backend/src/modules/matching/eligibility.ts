import { shiftWithinAvailability, type Window } from './availability.js';

export const RULES_VERSION = 'eligibility-v1';

export type Outcome = 'eligible' | 'ineligible' | 'pending_verification' | 'needs_review' | 'unavailable' | 'expired_credential';

/** Worst first. The overall outcome is the most severe one present; every reason is still reported. */
const SEVERITY: Outcome[] = ['ineligible', 'expired_credential', 'unavailable', 'needs_review', 'pending_verification'];

export interface EligibilityInput {
  professional: {
    professionId: string; accountStatus: string; specialtyIds: string[];
    experience: { startDate: string; endDate: string | null; specialtyId: string | null }[];
    availability: Window[]; availableFrom: string | null;
  };
  credentials: { id: string; kind: string; credentialType: string; jurisdiction: string | null; effectiveStatus: string; verificationMethod: string | null }[];
  job: { professionId: string; specialtyId: string | null; minYearsExperience: number | null; timezone: string; employmentType: string };
  /** Only mandatory requirements decide eligibility; preferred ones are ignored here. */
  requirements: { kind: string; credentialType: string | null; jurisdiction: string | null; description: string | null; mandatory: boolean }[];
  /** Shifts the applicant selected (empty = job-level application). */
  shifts: { id: string; startsAt: Date; endsAt: Date }[];
  /** Shifts already committed (accepted applications) that must not overlap. */
  conflicts: { startsAt: Date; endsAt: Date }[];
  now: Date;
}

export interface Reason { code: string; outcome: Outcome; message: string }
export interface RequirementResult {
  requirement: { kind: string; credentialType: string | null; jurisdiction: string | null; description: string | null };
  result: 'met' | 'pending' | 'expired' | 'missing' | 'unresolved' | 'rejected' | 'manual_review' | 'other_state_license';
  detail: string;
  credentialId?: string;
  credentialStatus?: string;
  /** How a met requirement was verified, so reviewers can see when it was a document review rather than a primary-source check. */
  verificationMethod?: string | null;
}
export interface EligibilityResult {
  outcome: Outcome; reasons: Reason[]; requirements: RequirementResult[];
  shifts: { shiftId: string; available: boolean; detail: string }[];
  experienceYears: number; rulesVersion: string;
}

const PENDING = ['submitted', 'pending_review', 'verification_in_progress'];
const UNRESOLVED = ['not_submitted', 'needs_more_information', 'unable_to_verify'];
const RANK = (status: string) => (status === 'verified' ? 0 : PENDING.includes(status) ? 1 : status === 'expired' ? 2 : UNRESOLVED.includes(status) ? 3 : 4);

/** Years of experience: union of the date ranges, so overlapping jobs are not double counted. */
export function experienceYears(entries: { startDate: string; endDate: string | null }[], now: Date): number {
  const ranges = entries
    .map((e) => [new Date(e.startDate).getTime(), e.endDate ? new Date(e.endDate).getTime() : now.getTime()] as [number, number])
    .filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0, curS = 0, curE = 0;
  for (const [s, e] of ranges) {
    if (curE === 0 || s > curE) { total += curE - curS; curS = s; curE = e; } else curE = Math.max(curE, e);
  }
  total += curE - curS;
  return Math.round((total / (365.25 * 86_400_000)) * 10) / 10;
}

const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const label = (r: { kind: string; credentialType: string | null; jurisdiction: string | null; description: string | null }) =>
  r.kind === 'license' ? `${r.credentialType} license (${r.jurisdiction})` : r.kind === 'certification' ? `${r.credentialType} certification` : `"${r.description}"`;

/**
 * Stage 1: mandatory eligibility. Pure function of its input: no ranking, no scores. A person is `eligible` only when
 * every mandatory condition is positively satisfied; anything unresolved produces a different outcome with the reason.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: Reason[] = [];
  const requirements: RequirementResult[] = [];
  const add = (code: string, outcome: Outcome, message: string) => reasons.push({ code, outcome, message });
  const { professional: p, job } = input;

  if (p.accountStatus !== 'active') add('account_not_active', 'ineligible', 'The professional account is restricted or suspended.');
  if (p.professionId !== job.professionId) add('profession_mismatch', 'ineligible', 'The professional\'s profession does not match the job.');
  if (job.specialtyId && !p.specialtyIds.includes(job.specialtyId)) {
    add('specialty_not_listed', 'needs_review', 'The job requires a specialty that is not listed on the profile; a person must review.');
  }

  const years = experienceYears(p.experience, input.now);
  if (job.minYearsExperience != null && years < job.minYearsExperience) {
    add('experience_below_minimum', 'needs_review',
      `Self-reported experience (${years} years) is below the ${job.minYearsExperience}-year minimum; a person must review.`);
  }

  for (const req of input.requirements.filter((r) => r.mandatory)) {
    const base = { kind: req.kind, credentialType: req.credentialType, jurisdiction: req.jurisdiction, description: req.description };
    const push = (result: RequirementResult['result'], detail: string, extra: Partial<RequirementResult> = {}) => requirements.push({ requirement: base, result, detail, ...extra });
    if (req.kind === 'other') {
      push('manual_review', 'This requirement cannot be checked automatically.');
      add('manual_requirement', 'needs_review', `Manual check needed: ${label(base)}.`);
      continue;
    }
    const matches = input.credentials.filter((c) =>
      c.kind === req.kind && same(c.credentialType, req.credentialType) && (req.kind !== 'license' || same(c.jurisdiction, req.jurisdiction)));
    const best = [...matches].sort((a, b) => RANK(a.effectiveStatus) - RANK(b.effectiveStatus))[0];
    const meta = best ? { credentialId: best.id, credentialStatus: best.effectiveStatus, verificationMethod: best.verificationMethod } : {};

    if (!best) {
      const otherState = req.kind === 'license' && input.credentials.some((c) => c.kind === 'license' && same(c.credentialType, req.credentialType));
      if (otherState) {
        push('other_state_license', 'A license of this type exists for another state. Compact privileges are not evaluated automatically.');
        add('other_state_license', 'needs_review', `Required: ${label(base)}. A license from another state is on file; compact/endorsement rules need a person to review.`);
      } else {
        push('missing', 'No matching credential on file.');
        add('credential_missing', 'ineligible', `Required: ${label(base)}. No matching credential is on file.`);
      }
    } else if (best.effectiveStatus === 'verified') {
      push('met', best.verificationMethod === 'primary_source' ? 'Verified with the primary source.' : 'Documents reviewed; not verified with the primary source.', meta);
    } else if (PENDING.includes(best.effectiveStatus)) {
      push('pending', 'Submitted; verification has not been completed.', meta);
      add('credential_pending', 'pending_verification', `Required: ${label(base)}. It is submitted but not yet verified.`);
    } else if (best.effectiveStatus === 'expired') {
      push('expired', 'The credential has expired.', meta);
      add('credential_expired', 'expired_credential', `Required: ${label(base)}. The matching credential has expired.`);
    } else if (UNRESOLVED.includes(best.effectiveStatus)) {
      push('unresolved', `Credential status is "${best.effectiveStatus}".`, meta);
      add('credential_unresolved', 'ineligible', `Required: ${label(base)}. The matching credential is not under active review (${best.effectiveStatus.replace(/_/g, ' ')}).`);
    } else {
      push('rejected', `Credential status is "${best.effectiveStatus}".`, meta);
      add('credential_rejected', 'ineligible', `Required: ${label(base)}. The matching credential was ${best.effectiveStatus}.`);
    }
  }

  const shifts: EligibilityResult['shifts'] = [];
  for (const s of input.shifts) {
    let detail = 'Within the professional\'s availability.';
    let ok = true;
    if (p.availability.length === 0) {
      ok = false; detail = 'No availability is on file.';
      add('availability_unknown', 'needs_review', 'The professional has not entered availability, so shift fit cannot be confirmed.');
    } else if (p.availableFrom && s.startsAt.toISOString().slice(0, 10) < p.availableFrom) {
      ok = false; detail = `Starts before the professional's available-from date (${p.availableFrom}).`;
      add('before_available_from', 'unavailable', detail);
    } else if (!shiftWithinAvailability(s.startsAt, s.endsAt, job.timezone, p.availability)) {
      ok = false; detail = 'Outside the professional\'s weekly availability.';
      add('outside_availability', 'unavailable', `A selected shift (${s.startsAt.toISOString()}) is outside the professional's weekly availability.`);
    }
    if (input.conflicts.some((c) => c.startsAt < s.endsAt && c.endsAt > s.startsAt)) {
      ok = false; detail = 'Overlaps a shift the professional has already accepted.';
      add('shift_conflict', 'unavailable', 'A selected shift overlaps a shift the professional has already accepted.');
    }
    shifts.push({ shiftId: s.id, available: ok, detail });
  }

  const outcome = SEVERITY.find((o) => reasons.some((r) => r.outcome === o)) ?? 'eligible';
  return { outcome, reasons, requirements, shifts, experienceYears: years, rulesVersion: RULES_VERSION };
}
