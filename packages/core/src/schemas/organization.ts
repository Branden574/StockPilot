import { z } from 'zod';

import { ROLES } from '../constants/roles';

import { emailSchema, slugSchema } from './common';

/**
 * The zone names the app and the database both use as an organization's zone
 * (B41). The web and the phone render through resolveOrgTimezone, which keeps
 * any zone this runtime's Intl accepts; the Book Order Totals report's SQL
 * tries only UTC, GMT or an Area/Location name of this shape and falls back to
 * Pacific otherwise (0379, 0382). A zone outside either would put the app and
 * the report on different clocks, so a create path stores only zones both use.
 */
const ORG_ZONE_SHAPE = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/;

export function isStorableOrgTimezone(raw: string): boolean {
  const zone = raw.trim();
  if (!(zone === 'UTC' || zone === 'GMT' || ORG_ZONE_SHAPE.test(zone))) return false;
  try {
    // Constructing the formatter is what validates the zone.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const ORG_TIMEZONE_INVALID_MESSAGE =
  'Enter a time zone name such as America/Chicago or UTC.';

/**
 * A zone typed in another case under its own name ('america/chicago' becomes
 * 'America/Chicago'): Intl and Postgres match zone names whatever their case,
 * but Settings finds a listed zone by its exact name. Only the letters' case
 * changes, never one name for another: Intl may answer an alias's other name
 * (America/Indianapolis for America/Indiana/Indianapolis), which is kept as
 * typed.
 */
function zoneInItsOwnCase(raw: string): string {
  try {
    const named = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
    return named.toLowerCase() === raw.toLowerCase() ? named : raw;
  } catch {
    return raw;
  }
}

/** An organization's zone as a create path takes it: trimmed, in its own
 *  case, and only a zone isStorableOrgTimezone accepts; `fallback` when none
 *  is sent. Every refusal says ORG_TIMEZONE_INVALID_MESSAGE. Onboarding and
 *  the platform console share it. */
export function storableOrgTimezoneSchema(fallback: string) {
  return z
    .string()
    .trim()
    .min(1, ORG_TIMEZONE_INVALID_MESSAGE)
    .max(64, ORG_TIMEZONE_INVALID_MESSAGE)
    .default(fallback)
    .transform(zoneInItsOwnCase)
    .refine(isStorableOrgTimezone, ORG_TIMEZONE_INVALID_MESSAGE);
}

export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(120).trim(),
  slug: slugSchema.optional(),
  industry: z.string().max(64).nullable().optional(),
  size: z.string().max(32).nullable().optional(),
  timezone: storableOrgTimezoneSchema('UTC'),
  currency: z.string().length(3).default('USD'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
/** What the form holds BEFORE parsing (defaults still optional). */
export type CreateOrganizationFormInput = z.input<typeof createOrganizationSchema>;

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
export type SetMemberWarehouseAccessInput = z.infer<typeof setMemberWarehouseAccessSchema>;

export const updateMemberRoleSchema = z.object({
  memberId: z.string().uuid(),
  role: z.enum(ROLES),
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(120),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
