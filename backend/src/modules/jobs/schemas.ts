import { z } from 'zod';
import { stateCode } from '../professionals/schemas.js';

export const EMPLOYMENT_TYPES = ['permanent', 'per_diem', 'contract', 'travel'] as const;
export const JOB_STATUSES = ['draft', 'published', 'paused', 'filled', 'closed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const dateTime = z.iso.datetime({ offset: true });
const text = (max: number, min = 1) => z.string().trim().min(min).max(max);

const jobBase = z.object({
  title: text(160, 3),
  description: text(8000),
  locationId: z.uuid(),
  departmentId: z.uuid().nullable(),
  professionId: z.uuid(),
  specialtyId: z.uuid().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  payUnit: z.enum(['hour', 'year']),
  payMinCents: z.number().int().min(0).max(2_000_000_000).nullable(),
  payMaxCents: z.number().int().min(0).max(2_000_000_000).nullable(),
  applicationDeadline: dateTime.nullable(),
  positionsCount: z.number().int().min(1).max(500),
  minYearsExperience: z.number().int().min(0).max(50).nullable(),
  noCredentialRequirements: z.boolean(),
});

/** Cross-field rules, applied to the merged (existing + changed) values. */
export function checkJobRules(j: { payUnit?: string; payMinCents?: number | null; payMaxCents?: number | null; applicationDeadline?: string | null }, nowMs: number) {
  const errors: Record<string, string[]> = {};
  if (j.payMinCents != null && j.payMaxCents != null && j.payMinCents > j.payMaxCents) errors.payMinCents = ['Minimum pay cannot exceed maximum pay.'];
  if (j.payUnit === 'hour' && ((j.payMinCents ?? 0) > 100_000 || (j.payMaxCents ?? 0) > 100_000)) errors.payMaxCents = ['Hourly pay is out of range.'];
  if (j.applicationDeadline && new Date(j.applicationDeadline).getTime() <= nowMs) errors.applicationDeadline = ['The deadline must be in the future.'];
  return errors;
}

export const createJobBody = jobBase
  .partial({ description: true, departmentId: true, specialtyId: true, payUnit: true, payMinCents: true, payMaxCents: true,
    applicationDeadline: true, positionsCount: true, minYearsExperience: true, noCredentialRequirements: true });

export const updateJobBody = jobBase.partial().refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');
export type UpdateJobBody = z.infer<typeof updateJobBody>;

/** Fields that change what the job IS. They are frozen once the job leaves draft so applicants are not misled. */
export const STRUCTURAL_FIELDS = ['locationId', 'departmentId', 'professionId', 'specialtyId', 'employmentType', 'payUnit', 'noCredentialRequirements'] as const;

export const requirementsBody = z.object({
  requirements: z.array(z.object({
    kind: z.enum(['license', 'certification', 'other']),
    credentialType: text(80).optional(),
    jurisdiction: stateCode.optional(),
    description: text(500).optional(),
    mandatory: z.boolean().default(true),
  }).refine((r) => r.kind === 'other' || !!r.credentialType, { message: 'credentialType is required', path: ['credentialType'] })
    .refine((r) => r.kind !== 'license' || !!r.jurisdiction, { message: 'A license requirement needs a jurisdiction', path: ['jurisdiction'] })
    .refine((r) => r.kind !== 'other' || !!r.description, { message: 'description is required', path: ['description'] })).max(30),
});

export const shiftBody = z.object({
  startsAt: dateTime,
  endsAt: dateTime,
  positions: z.number().int().min(1).max(100).default(1),
  hourlyRateCents: z.number().int().min(0).max(100_000).optional(),
  notes: text(500).optional(),
}).refine((s) => new Date(s.endsAt) > new Date(s.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((s) => new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime() <= 24 * 3600_000, { message: 'A shift cannot exceed 24 hours', path: ['endsAt'] });

export const shiftPatchBody = z.object({
  startsAt: dateTime.optional(), endsAt: dateTime.optional(), positions: z.number().int().min(1).max(100).optional(),
  hourlyRateCents: z.number().int().min(0).max(100_000).nullable().optional(), notes: text(500).nullable().optional(),
  status: z.literal('cancelled').optional(),
}).refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');

export const jobStatusBody = z.object({
  to: z.enum(['published', 'paused', 'filled', 'closed', 'cancelled']),
  reason: text(1000, 3).optional(),
});

export const listQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  professionId: z.uuid().optional(),
  specialtyId: z.uuid().optional(),
  state: stateCode.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  payUnit: z.enum(['hour', 'year']).optional(),
  minPayCents: z.coerce.number().int().min(0).max(2_000_000_000).optional(),
  shiftFrom: dateTime.optional(),
  shiftTo: dateTime.optional(),
  sort: z.enum(['published_at', 'pay_max', 'next_shift']).default('published_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const params = {
  org: z.object({ orgId: z.uuid() }),
  job: z.object({ orgId: z.uuid(), jobId: z.uuid() }),
  shift: z.object({ orgId: z.uuid(), jobId: z.uuid(), shiftId: z.uuid() }),
  id: z.object({ id: z.uuid() }),
};
