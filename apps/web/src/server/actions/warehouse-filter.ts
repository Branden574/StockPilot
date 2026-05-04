'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { WAREHOUSE_FILTER_COOKIE } from '@/lib/warehouse-filter';

export async function setWarehouseFilterAction(warehouseId: string | null) {
  const access = await getWarehouseAccess();
  // Only managers/admins use this filter; warehouse-scoped users have a forced
  // warehouse and never benefit from the cookie.
  if (!access.hasAllAccess) return { ok: false as const, error: 'forbidden' };

  if (warehouseId && !access.readableIds.includes(warehouseId)) {
    return { ok: false as const, error: 'forbidden' };
  }

  const c = await cookies();
  if (warehouseId) {
    c.set(WAREHOUSE_FILTER_COOKIE, warehouseId, {
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });
  } else {
    c.delete(WAREHOUSE_FILTER_COOKIE);
  }

  revalidatePath('/dashboard', 'layout');
  return { ok: true as const };
}
