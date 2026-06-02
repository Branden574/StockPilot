'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { PriceTrackingService, type PriceObservationRow } from '@/server/services/price-tracking';
import { ServiceError } from '@/server/services/context';

export async function fetchItemPriceAction(itemId: string): Promise<ActionResult<PriceObservationRow | null>> {
  if (!z.string().min(1).safeParse(itemId).success) return err('validation_error', 'Missing item id.');
  try {
    const svc = await PriceTrackingService.forCurrentUser();
    const obs = await svc.fetchItemPrice(itemId);
    revalidatePath(`/dashboard/inventory/${itemId}`);
    return ok(obs);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function refreshBookPricesAction(): Promise<ActionResult<{ scanned: number; written: number; skipped: number }>> {
  try {
    const svc = await PriceTrackingService.forCurrentUser();
    const summary = await svc.refreshOrgBookPrices();
    revalidatePath('/dashboard/books');
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
