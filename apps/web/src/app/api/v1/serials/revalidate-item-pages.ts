import { revalidatePath } from 'next/cache';

import { reportError } from '@/lib/error-reporter';

/**
 * The item pages the serial number actions refresh (server/actions/serials.ts
 * revalidateItemDetail: inventory, books, rentals), for the serial number
 * routes. The change is saved by the time this runs, so a refresh that
 * fails is reported, never answered.
 */
export function revalidateItemPages(itemId: string, organizationId: string, tag: string): void {
  try {
    revalidatePath(`/dashboard/inventory/${itemId}`);
    revalidatePath(`/dashboard/books/${itemId}`);
    revalidatePath(`/dashboard/rentals/items/${itemId}`);
  } catch (e) {
    void reportError(e, { tag, organizationId });
  }
}
