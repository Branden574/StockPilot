import { z } from 'zod';

import { ROLES } from '../constants/roles';

import { emailSchema, slugSchema } from './common';

export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(120).trim(),
  slug: slugSchema.optional(),
  industry: z.string().max(64).nullable().optional(),
  size: z.string().max(32).nullable().optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
  currency: z.string().length(3).default('USD'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(120).trim().optional(),
  logoUrl: z.string().url().nullable().optional(),
  industry: z.string().max(64).nullable().optional(),
  size: z.string().max(32).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  currency: z.string().length(3).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).default('staff'),
  charterId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  message: z.string().max(2000).optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  memberId: z.string().uuid(),
  role: z.enum(ROLES),
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(120),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
