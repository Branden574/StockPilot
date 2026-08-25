import { z } from 'zod';

import { emailSchema, passwordSchema } from './common';

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().min(1, 'Name is required').max(120).trim(),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().default(true),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const requestPasswordResetSchema = z.object({
  email: emailSchema,
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const completePasswordResetSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type CompletePasswordResetInput = z.infer<typeof completePasswordResetSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must be different from current',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Self-service email change. Trim BEFORE validating (a pasted address with a
 * trailing space is a typo, not an attack) and lowercase the result so every
 * comparison against auth.users / the citext profile column is stable.
 * Nothing else is normalised: plus-addresses and dots are real mailbox
 * semantics and stay as typed.
 */
export const changeEmailSchema = z.object({
  newEmail: z
    .string()
    .trim()
    .min(1, 'Enter your new email address')
    .max(254, 'That email address is too long')
    .email('Enter a valid email address')
    .toLowerCase(),
  currentPassword: z.string().min(1, 'Enter your current password'),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;

export const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(120).trim().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
