'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { PriceTrackingService, type PriceObservationRow } from '@/server/services/price-tracking';
import { actionErrorResult } from '@/server/lib/action-error-result';

export async function fetchItemPriceAction(itemId: string): Promise<ActionResult<PriceObservationRow | null>> {
  if (!z.string().min(1).safeParse(itemId).success) return err('validation_error', 'Missing item id.');
  try {
    const svc = await PriceTrackingService.forCurrentUser();
    const obs = await svc.fetchItemPrice(itemId);
    revalidatePath(`/dashboard/inventory/${itemId}`);
    await revalidateInventoryListForCurrentOrg();
    return ok(obs);
  } catch (e) {
    return actionErrorResult(e, 'actions.price_tracking.fetch_item_price');
  }
}

export async function refreshBookPricesAction(): Promise<ActionResult<{ scanned: number; written: number; skipped: number }>> {
  try {
    const svc = await PriceTrackingService.forCurrentUser();
    const summary = await svc.refreshOrgBookPrices();
    revalidatePath('/dashboard/books');
    await revalidateInventoryListForCurrentOrg();
    return ok(summary);
  } catch (e) {
    return actionErrorResult(e, 'actions.price_tracking.refresh_book_prices');
  }
}
