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
  poTerms: z.string().max(2000).nullable().optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

// Inviteable roles never include `owner` — owner is only reassigned via
// the ownership-transfer flow. Keeping this enum tight here gives a
// clean validation error at the schema layer instead of relying on the
// action to re-check.
export const INVITEABLE_ROLES = ['admin', 'manager', 'staff', 'viewer'] as const;
export type InviteableRole = (typeof INVITEABLE_ROLES)[number];

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(INVITEABLE_ROLES).default('staff'),
  // Single charter (back-compat). `charterIds` takes precedence when set.
  charterId: z.string().uuid().nullable().optional(),
  // Multi-charter invite: charters this user will oversee for the warehouse.
  charterIds: z.array(z.string().uuid()).optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  // All-warehouse access: the invitee gets organization_members.all_warehouses
  // plus one assignment row per current warehouse on accept (future warehouses
  // are covered by the 0280 trigger). Mutually exclusive with warehouseId /
  // charter scoping — the service nulls those out when this is true.
  allWarehouses: z.boolean().optional(),
  message: z.string().max(2000).optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const setMemberChartersSchema = z.object({
  userId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  // Empty array = "all charters" (a single null-charter assignment row).
  charterIds: z.array(z.string().uuid()),
});
export type SetMemberChartersInput = z.infer<typeof setMemberChartersSchema>;

// Post-invite warehouse-access editing (Team page): either all warehouses
// (flag + a row per warehouse) or exactly one warehouse (rows reconciled to
// it — assignments at other warehouses, including their charter scoping, are
// removed by design).
export const setMemberWarehouseAccessSchema = z
  .object({
    userId: z.string().uuid(),
    allWarehouses: z.boolean(),
    warehouseId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.allWarehouses || Boolean(v.warehouseId), {
    message: 'Pick a warehouse or choose all warehouses.',
    path: ['warehouseId'],
  });
export type SetMemberWarehouseAccessInput = z.infer<
  typeof setMemberWarehouseAccessSchema
>;

export const updateMemberRoleSchema = z.object({
  memberId: z.string().uuid(),
  role: z.enum(ROLES),
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(120),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
