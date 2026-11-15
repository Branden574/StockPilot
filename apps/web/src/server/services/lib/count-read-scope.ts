import 'server-only';

import { isManagerOrAbove } from '@stockpilot/core';

import { countReadScope, type CountReadScope } from '@/lib/auth/count-read-scope';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { ServiceError, type ServiceContext } from '../context';

/**
 * Which cycle counts this caller reads: the one rule of
 * lib/auth/count-read-scope.ts, resolved for a service context. Asked by the
 * count service (the list, the count page and the count sheet) and by the
 * Exception Center's read of one count's linked exceptions.
 *
 * Managers and above see every count by ROLE alone, the first rule in
 * getWarehouseAccess (isManagerOrAbove), so no warehouse read is made for
 * them: on the Bearer path that read was a round trip whose answer went
 * unused. Everyone else is decided by their assignments. An access read that
 * FAILED is an error to try again, never a scope: its empty id list would
 * read as a member with no warehouse.
 */
export async function readCountScope(ctx: ServiceContext): Promise<CountReadScope> {
  const access = isManagerOrAbove(ctx.role) ? null : await getWarehouseAccess(ctx);
  if (access && !access.hasAllAccess && access.unreadable) {
    throw new ServiceError(
      'internal_error',
      'Could not check which warehouses you can see. Try again.',
    );
  }
  return countReadScope(access, ctx.userId);
}
