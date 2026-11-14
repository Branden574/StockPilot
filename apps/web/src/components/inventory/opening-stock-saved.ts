import type { ActionError } from '@stockpilot/core';

/**
 * A create whose items were SAVED but whose opening quantity was not recorded
 * (the opening helper's 'opening_stock_not_recorded' conflict). The record
 * exists, so a screen must not stay open for a second press, which would save
 * a second item: it shows the sentence and goes to the saved record.
 */
export function isOpeningStockSaved(error: ActionError): boolean {
  return error.code === 'conflict' && error.details?.reason === 'opening_stock_not_recorded';
}

/**
 * Where to go after such a create: the item's page for one item, the list for
 * several. Null for any other refusal, which keeps the form as it is.
 */
export function openingStockSavedHref(error: ActionError, isBook: boolean): string | null {
  if (!isOpeningStockSaved(error)) return null;
  const base = isBook ? '/dashboard/books' : '/dashboard/inventory';
  const ids = error.details?.itemIds;
  const one =
    error.details?.total === 1 && Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string';
  return one ? `${base}/${ids[0] as string}` : base;
}
