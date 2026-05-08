'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { WAREHOUSE_FILTER_COOKIE } from '@/lib/warehouse-filter';
import {
  SavedViewsService,
  type SavedViewScope,
  type SavedViewState,
} from '@/server/services/saved-views';
import { ServiceError } from '@/server/services/context';

export async function createSavedViewAction(input: {
  scope: SavedViewScope;
  name: string;
  state: SavedViewState;
}) {
  try {
    const svc = await SavedViewsService.forCurrentUser();
    const view = await svc.create(input);
    revalidatePath(input.scope === 'inventory' ? '/dashboard/inventory' : '/dashboard/books');
    return { ok: true as const, data: view };
  } catch (e) {
    if (e instanceof ServiceError) {
      return { ok: false as const, error: { code: e.code, message: e.message } };
    }
    return {
      ok: false as const,
      error: { code: 'internal_error', message: 'Failed to save view.' },
    };
  }
}

export async function deleteSavedViewAction(id: string, scope: SavedViewScope) {
  try {
    const svc = await SavedViewsService.forCurrentUser();
    await svc.remove(id);
    revalidatePath(scope === 'inventory' ? '/dashboard/inventory' : '/dashboard/books');
    return { ok: true as const, data: { id } };
  } catch (e) {
    if (e instanceof ServiceError) {
      return { ok: false as const, error: { code: e.code, message: e.message } };
    }
    return {
      ok: false as const,
      error: { code: 'internal_error', message: 'Failed to delete view.' },
    };
  }
}

/**
 * Sets (or clears) the active warehouse filter cookie. The dashboard
 * + inventory + books pages read this via getActiveWarehouseFilter()
 * and apply it server-side. Used by the saved-view apply path so a
 * view that captured a warehouse can restore it.
 */
export async function setActiveWarehouseAction(warehouseId: string | null) {
  const c = await cookies();
  if (warehouseId) {
    c.set(WAREHOUSE_FILTER_COOKIE, warehouseId, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  } else {
    c.delete(WAREHOUSE_FILTER_COOKIE);
  }
  revalidatePath('/dashboard/inventory');
  revalidatePath('/dashboard/books');
  return { ok: true as const };
}
