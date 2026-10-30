import { experienceYears } from './eligibility.js';

export const RANKING_VERSION = 'ranking-v1';

/** Starting proposal from the product blueprint. NOT a validated benchmark: it needs domain and legal review. */
export const DEFAULT_WEIGHTS = {
  specialty: 25, experience: 20, location: 15, availability: 15, compensation: 10, workHistory: 10, completeness: 5,
} as const;
export type Weights = Record<keyof typeof DEFAULT_WEIGHTS, number>;

export interface RankInput {
  professional: {
    specialtyIds: string[]; homeState: string | null; completenessPercent: number;
    experience: { startDate: string; endDate: string | null; specialtyId: string | null }[];
    preferredStates: string[]; employmentTypes: string[]; minHourlyRateCents: number | null;
  };
  job: { specialtyId: string | null; minYearsExperience: number | null; state: string; employmentType: string; payUnit: string; payMaxCents: number | null };
  now: Date;
}

export interface Factor { key: keyof Weights; label: string; weight: number; value: number; contribution: number; note: string }
export interface RankResult { score: number; factors: Factor[]; rankingVersion: string }

const NEUTRAL = 0.5;

/**
 * Stage 2: ranking, applied ONLY to candidates already judged eligible. Uses job-relevant factors only (no names, age,
 * gender, ethnicity, photos or other protected characteristics or proxies) and explains every factor.
 */
export function rankCandidate(input: RankInput, weights: Weights): RankResult {
  const { professional: p, job } = input;
  const f: Record<keyof Weights, { label: string; value: number; note: string }> = {
    specialty: job.specialtyId
      ? (p.specialtyIds.includes(job.specialtyId)
        ? { label: 'Specialty relevance', value: 1, note: 'The job\'s specialty is listed on the profile.' }
        : { label: 'Specialty relevance', value: 0, note: 'The job\'s specialty is not listed on the profile.' })
      : { label: 'Specialty relevance', value: NEUTRAL, note: 'The job does not require a specialty (neutral).' },
    experience: (() => {
      const relevant = p.experience.filter((e) => !job.specialtyId || e.specialtyId === job.specialtyId);
      const years = experienceYears(relevant, input.now);
      const target = Math.max(job.minYearsExperience ?? 0, 2);
      return { label: 'Experience relevance', value: Math.min(1, years / target), note: `${years} self-reported relevant years against a ${target}-year reference.` };
    })(),
    location: p.preferredStates.length
      ? (p.preferredStates.includes(job.state)
        ? { label: 'Location preference', value: 1, note: `${job.state} is a preferred work state.` }
        : { label: 'Location preference', value: 0, note: `${job.state} is not among the preferred work states.` })
      : (p.homeState === job.state
        ? { label: 'Location preference', value: 1, note: 'No preferred states set; the profile state matches the job.' }
        : { label: 'Location preference', value: NEUTRAL, note: 'No preferred states set (neutral).' }),
    availability: p.employmentTypes.length
      ? (p.employmentTypes.includes(job.employmentType)
        ? { label: 'Work-arrangement fit', value: 1, note: `Prefers ${job.employmentType.replace('_', ' ')} work.` }
        : { label: 'Work-arrangement fit', value: 0, note: `Does not list ${job.employmentType.replace('_', ' ')} among preferred employment types.` })
      : { label: 'Work-arrangement fit', value: NEUTRAL, note: 'No employment-type preference set (neutral).' },
    compensation: (p.minHourlyRateCents == null || job.payMaxCents == null || job.payUnit !== 'hour')
      ? { label: 'Compensation compatibility', value: NEUTRAL, note: 'Pay expectation or hourly job pay unavailable (neutral).' }
      : { label: 'Compensation compatibility', value: Math.min(1, job.payMaxCents / Math.max(1, p.minHourlyRateCents)),
          note: `Job pays up to ${job.payMaxCents} cents/hour against a ${p.minHourlyRateCents} cents/hour minimum.` },
    workHistory: (() => {
      if (!p.experience.length) return { label: 'Recent work history', value: 0, note: 'No work history entered.' };
      if (p.experience.some((e) => !e.endDate)) return { label: 'Recent work history', value: 1, note: 'Currently working.' };
      const latest = Math.max(...p.experience.map((e) => new Date(e.endDate!).getTime()));
      const months = (input.now.getTime() - latest) / (30.44 * 86_400_000);
      return months <= 24
        ? { label: 'Recent work history', value: 1, note: 'Last role ended within 24 months.' }
        : months <= 60 ? { label: 'Recent work history', value: 0.5, note: 'Last role ended within 5 years.' }
        : { label: 'Recent work history', value: 0, note: 'Last role ended more than 5 years ago.' };
    })(),
    completeness: { label: 'Profile completeness', value: p.completenessPercent / 100, note: `${p.completenessPercent}% of profile sections completed (not a measure of verification).` },
  };
  const factors: Factor[] = (Object.keys(f) as (keyof Weights)[]).map((key) => ({
    key, label: f[key].label, weight: weights[key], value: Math.round(f[key].value * 1000) / 1000,
    contribution: Math.round(weights[key] * f[key].value * 100) / 100, note: f[key].note,
  }));
  const score = Math.round(factors.reduce((a, x) => a + x.contribution, 0) * 100) / 100;
  return { score, factors, rankingVersion: RANKING_VERSION };
}
