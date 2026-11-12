/**
 * THE ITEM ID ON A STOCKPILOT ITEM LABEL, FROM A SCANNED CODE (Scan tab).
 *
 * The /api/v1/items/[id]/barcode QR endpoint encodes
 *   <origin>/p/items/<uuid>              (current — public read-only page)
 *   <origin>/dashboard/inventory/<uuid>  (legacy — pre-2026-05-06 stickers)
 *   <origin>/dashboard/books/<uuid>      (legacy)
 * so we accept any of the three for back-compat with already-printed
 * labels.
 *
 * Only a uuid (core isUuid) is a label id (B65). The 36 characters after the
 * path used to be any hex digits or hyphens, so a near-miss (36 hyphens, 36
 * digits with no hyphens) went to the item read by id, which Postgres
 * refuses, and the scan fell through to Add item. A head that is not a uuid
 * now reads as no label id, as a cut-off label always did: the Scan tab looks
 * the whole code up as a barcode or SKU, then as an ISBN or UPC.
 *
 * Pure: no React Native import, no I/O.
 */

import { isUuid } from '@stockpilot/core';

const ITEM_LABEL_PATH = /\/(?:p\/items|dashboard\/(?:inventory|books))\/([0-9a-f-]{36})/i;

/** The item id a scanned label carries, as scanned (never rewritten), or null. */
export function parseItemId(scanned: string): string | null {
  const head = scanned.match(ITEM_LABEL_PATH)?.[1];
  return isUuid(head) ? head : null;
}
