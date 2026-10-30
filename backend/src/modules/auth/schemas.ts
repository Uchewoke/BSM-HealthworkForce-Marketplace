import { z } from 'zod';

export const emailSchema = z.email().max(254).transform((e) => e.trim().toLowerCase());
export const passwordSchema = z.string().min(12, 'Password must be at least 12 characters.').max(128);

export const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120),
});
export const verifyEmailBody = z.object({ token: z.string().min(20).max(200) });
export const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export const forgotBody = z.object({ email: emailSchema });
export const resetBody = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const mfaConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });
