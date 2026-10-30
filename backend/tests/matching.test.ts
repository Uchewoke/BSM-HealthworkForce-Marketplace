import { describe, expect, it } from 'vitest';
import { shiftWithinAvailability, type Window } from '../src/modules/matching/availability.js';
import { evaluateEligibility, experienceYears, type EligibilityInput } from '../src/modules/matching/eligibility.js';
import { DEFAULT_WEIGHTS, rankCandidate } from '../src/modules/matching/ranking.js';
import { weightsSchema } from '../src/modules/matching/loader.js';

const NOW = new Date('2026-10-30T12:00:00Z');
const base = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  professional: { professionId: 'rn', accountStatus: 'active', specialtyIds: ['icu'], experience: [{ startDate: '2018-01-01', endDate: null, specialtyId: 'icu' }], availability: [], availableFrom: null },
  credentials: [{ id: 'c1', kind: 'license', credentialType: 'RN', jurisdiction: 'GA', effectiveStatus: 'verified', verificationMethod: 'primary_source' },
    { id: 'c2', kind: 'certification', credentialType: 'BLS', jurisdiction: null, effectiveStatus: 'verified', verificationMethod: 'document_review' }],
  job: { professionId: 'rn', specialtyId: 'icu', minYearsExperience: 2, timezone: 'America/New_York', employmentType: 'permanent' },
  requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA', description: null, mandatory: true }, { kind: 'certification', credentialType: 'BLS', jurisdiction: null, description: null, mandatory: true }],
  shifts: [], conflicts: [], now: NOW, ...over,
});
const withCred = (status: string, method: string | null = null, extra: Partial<EligibilityInput['credentials'][0]> = {}) =>
  [{ id: 'c1', kind: 'license', credentialType: 'RN', jurisdiction: 'GA', effectiveStatus: status, verificationMethod: method, ...extra },
   { id: 'c2', kind: 'certification', credentialType: 'BLS', jurisdiction: null, effectiveStatus: 'verified', verificationMethod: 'document_review' }];

describe('eligibility engine: mandatory conditions', () => {
  it('is eligible only when every mandatory condition is positively met', () => {
    const r = evaluateEligibility(base());
    expect(r.outcome).toBe('eligible');
    expect(r.reasons).toEqual([]);
    expect(r.requirements.every((x) => x.result === 'met')).toBe(true);
    expect(r.requirements.find((x) => x.requirement.kind === 'certification')!.verificationMethod).toBe('document_review');
  });

  it.each([
    ['submitted', 'pending_verification'], ['pending_review', 'pending_verification'], ['verification_in_progress', 'pending_verification'],
    ['expired', 'expired_credential'], ['not_submitted', 'ineligible'], ['needs_more_information', 'ineligible'],
    ['unable_to_verify', 'ineligible'], ['rejected', 'ineligible'], ['revoked', 'ineligible'],
  ])('a license that is %s gives outcome %s, never eligible', (status, outcome) => {
    const r = evaluateEligibility(base({ credentials: withCred(status) }));
    expect(r.outcome).toBe(outcome);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('missing credential is ineligible; a license from another state needs a person to review', () => {
    expect(evaluateEligibility(base({ credentials: [] })).outcome).toBe('ineligible');
    const other = evaluateEligibility(base({ credentials: withCred('verified', 'primary_source', { jurisdiction: 'FL' }) }));
    expect(other.outcome).toBe('needs_review');
    expect(other.requirements[0]!.result).toBe('other_state_license');
  });

  it('prefers the best matching credential and ignores non-mandatory requirements', () => {
    const creds = [...withCred('expired'), { id: 'c9', kind: 'license', credentialType: 'rn', jurisdiction: 'ga', effectiveStatus: 'verified', verificationMethod: 'primary_source' }];
    expect(evaluateEligibility(base({ credentials: creds })).outcome).toBe('eligible');
    const preferred = evaluateEligibility(base({ credentials: [], requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA', description: null, mandatory: false }] }));
    expect(preferred.outcome).toBe('eligible');
  });

  it('profession mismatch, restricted accounts, manual requirements, specialty and experience shortfalls', () => {
    expect(evaluateEligibility(base({ job: { ...base().job, professionId: 'pt' } })).outcome).toBe('ineligible');
    expect(evaluateEligibility(base({ professional: { ...base().professional, accountStatus: 'suspended' } })).outcome).toBe('ineligible');
    expect(evaluateEligibility(base({ requirements: [{ kind: 'other', credentialType: null, jurisdiction: null, description: 'Union card', mandatory: true }] })).outcome).toBe('needs_review');
    expect(evaluateEligibility(base({ professional: { ...base().professional, specialtyIds: [] } })).outcome).toBe('needs_review');
    expect(evaluateEligibility(base({ professional: { ...base().professional, experience: [] } })).outcome).toBe('needs_review');
  });

  it('reports every reason and uses the most severe outcome', () => {
    const r = evaluateEligibility(base({ credentials: withCred('expired'), professional: { ...base().professional, specialtyIds: [] } }));
    expect(r.outcome).toBe('expired_credential');
    expect(r.reasons.map((x) => x.code).sort()).toEqual(['credential_expired', 'specialty_not_listed']);
    const worst = evaluateEligibility(base({ credentials: [], professional: { ...base().professional, specialtyIds: [] } }));
    expect(worst.outcome).toBe('ineligible');
    // Nothing is hidden: two missing credentials plus the specialty reason are all reported.
    expect(worst.reasons.map((x) => x.code).sort()).toEqual(['credential_missing', 'credential_missing', 'specialty_not_listed']);
  });
});

describe('eligibility engine: shifts and availability', () => {
  const week: Window[] = [{ dayOfWeek: 1, startTime: '07:00', endTime: '19:00' }, { dayOfWeek: 3, startTime: '19:00', endTime: '07:00' }];
  // 2026-11-02 is a Monday. 07:00-19:00 America/New_York (EST, UTC-5) = 12:00-00:00Z.
  const day = { id: 's1', startsAt: new Date('2026-11-02T12:00:00Z'), endsAt: new Date('2026-11-03T00:00:00Z') };
  const prof = (a: Window[], from: string | null = null) => ({ ...base().professional, availability: a, availableFrom: from });
  const jobShifts = { ...base().job, employmentType: 'per_diem' };

  it('checks shifts in the facility\'s time zone, including overnight windows', () => {
    expect(shiftWithinAvailability(day.startsAt, day.endsAt, 'America/New_York', week)).toBe(true);
    expect(shiftWithinAvailability(day.startsAt, day.endsAt, 'America/Los_Angeles', week)).toBe(false); // same instant is 09:00-21:00 Pacific
    const night = { startsAt: new Date('2026-11-05T00:00:00Z'), endsAt: new Date('2026-11-05T12:00:00Z') }; // Wed 19:00 - Thu 07:00 Eastern
    expect(shiftWithinAvailability(night.startsAt, night.endsAt, 'America/New_York', week)).toBe(true);
    expect(shiftWithinAvailability(new Date('2026-11-02T11:00:00Z'), day.endsAt, 'America/New_York', week)).toBe(false); // starts 06:00
  });

  it('available shifts keep the candidate eligible; others explain why', () => {
    expect(evaluateEligibility(base({ job: jobShifts, professional: prof(week), shifts: [day] })).outcome).toBe('eligible');
    const out = evaluateEligibility(base({ job: jobShifts, professional: prof([{ dayOfWeek: 2, startTime: '07:00', endTime: '19:00' }]), shifts: [day] }));
    expect(out.outcome).toBe('unavailable');
    expect(out.shifts[0]).toMatchObject({ shiftId: 's1', available: false });
  });

  it('no availability on file needs review; available-from and conflicts make them unavailable', () => {
    expect(evaluateEligibility(base({ job: jobShifts, professional: prof([]), shifts: [day] })).outcome).toBe('needs_review');
    expect(evaluateEligibility(base({ job: jobShifts, professional: prof(week, '2026-12-01'), shifts: [day] })).outcome).toBe('unavailable');
    const conflict = evaluateEligibility(base({ job: jobShifts, professional: prof(week), shifts: [day], conflicts: [{ startsAt: new Date('2026-11-02T18:00:00Z'), endsAt: new Date('2026-11-03T02:00:00Z') }] }));
    expect(conflict.outcome).toBe('unavailable');
    expect(conflict.reasons.map((r) => r.code)).toContain('shift_conflict');
  });

  it('counts overlapping experience once', () => {
    expect(experienceYears([{ startDate: '2020-01-01', endDate: '2022-01-01' }, { startDate: '2021-01-01', endDate: '2022-01-01' }], NOW)).toBeCloseTo(2, 0);
    expect(experienceYears([{ startDate: '2025-10-30', endDate: null }], NOW)).toBeCloseTo(1, 0);
  });
});

describe('ranking (applies only to eligible candidates, with explanations)', () => {
  const rank = (over: object = {}, jobOver: object = {}) => rankCandidate({
    professional: { specialtyIds: ['icu'], homeState: 'GA', completenessPercent: 100, experience: [{ startDate: '2018-01-01', endDate: null, specialtyId: 'icu' }],
      preferredStates: ['GA'], employmentTypes: ['per_diem'], minHourlyRateCents: 4500, ...over },
    job: { specialtyId: 'icu', minYearsExperience: 2, state: 'GA', employmentType: 'per_diem', payUnit: 'hour', payMaxCents: 6500, ...jobOver }, now: NOW,
  }, { ...DEFAULT_WEIGHTS });

  it('scores a strong match at 100 and explains every factor', () => {
    const r = rank();
    expect(r.score).toBe(100);
    expect(r.factors).toHaveLength(7);
    expect(r.factors.every((f) => f.note.length > 10)).toBe(true);
    expect(r.factors.reduce((a, f) => a + f.weight, 0)).toBe(100);
  });

  it('ranks a weaker fit lower and uses neutral values for unknowns', () => {
    const weak = rank({ specialtyIds: [], preferredStates: ['TX'], employmentTypes: ['permanent'], minHourlyRateCents: 13000, completenessPercent: 40 });
    expect(weak.score).toBeLessThan(rank().score);
    const unknown = rank({ preferredStates: [], employmentTypes: [], minHourlyRateCents: null }, { payMaxCents: null });
    expect(unknown.factors.find((f) => f.key === 'compensation')!.value).toBe(0.5);
    expect(unknown.factors.find((f) => f.key === 'availability')!.value).toBe(0.5);
  });

  it('uses only job-relevant inputs (no personal attributes are even accepted)', () => {
    const keys = Object.keys(rank().factors.reduce((a, f) => ({ ...a, [f.key]: 1 }), {}));
    expect(keys.sort()).toEqual(['availability', 'compensation', 'completeness', 'experience', 'location', 'specialty', 'workHistory']);
  });

  it('weights must add up to 100', () => {
    expect(weightsSchema.safeParse(DEFAULT_WEIGHTS).success).toBe(true);
    expect(weightsSchema.safeParse({ ...DEFAULT_WEIGHTS, specialty: 90 }).success).toBe(false);
    expect(weightsSchema.safeParse({ ...DEFAULT_WEIGHTS, extra: 0 }).success).toBe(false);
    expect(weightsSchema.safeParse({ ...DEFAULT_WEIGHTS, specialty: -5, experience: 50 }).success).toBe(false);
  });
});
