import { can, type Permission, type Role } from '@stockpilot/core';

/**
 * Whether this reader can open a cycle count's page, so the verification
 * words link a count ("CC-000031", "Being counted in CC-000045") only for a
 * reader the count page would let in, and name it as plain text for everyone
 * else. The same rule as the count pages' own gate
 * (app/(dashboard)/dashboard/cycle-counts/page.tsx and [id]/page.tsx, and
 * CycleCountsService's read gate): cycle_counts:read, or stock:adjust. A
 * display hint only: the count page re-checks, and redirects anyone else.
 */
export function canOpenCountPage(ctx: {
  role: Role;
  permissions?: ReadonlySet<Permission>;
}): boolean {
  return can(ctx, 'cycle_counts:read') || can(ctx, 'stock:adjust');
}
