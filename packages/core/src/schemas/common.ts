import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().email().max(254).toLowerCase().trim();
export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and dashes');

export const paginationSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(72, 'Too long')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');
