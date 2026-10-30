import { z } from 'zod';

export const stateCode = z.string().trim().length(2).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/));
export const phone = z.string().trim().regex(/^\+?[0-9 ()\-.]{7,20}$/, 'Invalid phone number');
const text = (max: number, min = 1) => z.string().trim().min(min).max(max);
export const isoDate = z.iso.date();

export const profileBody = z.object({
  professionId: z.uuid(),
  headline: text(160).optional(),
  summary: text(4000).optional(),
  phone: phone.optional(),
  city: text(100).optional(),
  state: stateCode.optional(),
});
export const profilePatch = profileBody.omit({ professionId: true }).partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');

export const specialtiesBody = z.object({ specialtyIds: z.array(z.uuid()).max(20) });

export const educationBody = z.object({
  institution: text(200), degree: text(120), fieldOfStudy: text(120).optional(),
  startYear: z.number().int().min(1940).max(2100).optional(), endYear: z.number().int().min(1940).max(2100).optional(),
}).refine((b) => b.endYear === undefined || b.startYear === undefined || b.endYear >= b.startYear, 'endYear must not precede startYear');

export const experienceBody = z.object({
  employer: text(200), title: text(120), specialtyId: z.uuid().optional(), city: text(100).optional(), state: stateCode.optional(),
  startDate: isoDate, endDate: isoDate.optional(), isCurrent: z.boolean().default(false), description: text(4000).optional(),
}).refine((b) => !b.endDate || b.endDate >= b.startDate, 'endDate must not precede startDate')
  .refine((b) => !b.isCurrent || !b.endDate, 'A current position cannot have an end date');

export const EMPLOYMENT_TYPES = ['permanent', 'per_diem', 'contract', 'travel'] as const;
export const SHIFT_TYPES = ['day', 'evening', 'night', 'weekend'] as const;
export const preferencesBody = z.object({
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(4),
  shiftTypes: z.array(z.enum(SHIFT_TYPES)).max(4),
  preferredStates: z.array(stateCode).max(51),
  maxTravelMiles: z.number().int().min(0).max(3000).optional(),
  minHourlyRateCents: z.number().int().min(0).max(100_000).optional(),
  availableFrom: isoDate.optional(),
});

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
export const availabilityBody = z.object({
  windows: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), startTime: time, endTime: time })
    .refine((w) => w.startTime !== w.endTime, 'startTime and endTime must differ')).max(50),
});

export const idParams = z.object({ id: z.uuid() });
