/**
 * A purchase order's bill-to charter in words (B56): the charter it is
 * invoiced to, purchase_orders.charter_id (0186), which the PO PDF prints under
 * "Bill to". The web PO page, the phone's PO screen and the PDF print its name
 * line from here, so the three read the same. It is never the charter that
 * owns an item's stock (inventory_items.charter_id): nothing here reads or
 * derives that.
 *
 * Once a PO leaves draft its charter is fixed (0364's guard), but the charter
 * can be archived later, so the read is at any status and the status is marked
 * (core recordStatusSuffix). A read that failed is said, never shown as an
 * empty name or as no bill-to.
 *
 * Pure: no I/O, no platform API.
 */

import { recordStatusSuffix } from '../labels/record-status-suffix';

/** The PDF's own word for the block (lib/pdf/po.tsx), not the organization's
 *  renamable charter term. */
export const PO_BILL_TO_LABEL = 'Bill to';

/** The charter's read failed: said in place of its name. */
export const PO_BILL_TO_UNREADABLE = 'Could not be loaded';

/** The charters columns the label is built from. */
export interface BillToCharter {
  id: string;
  name: string | null;
  code: string | null;
  status: string | null;
}

/** What a bill-to read answered: no charter on the PO, the charter, or a read
 *  that failed (an error, no row, or a row for another charter). */
export type BillToCharterRead =
  | { state: 'none' }
  | { state: 'found'; charter: BillToCharter }
  | { state: 'unreadable'; charterId: string };

/**
 * The PDF's name line, "North Campus (NC)": the name, then the code in
 * brackets when there is one. Both are trimmed, so a code of spaces adds no
 * brackets, and a blank name reads 'Unnamed charter', core's own word for one
 * (the Book Order Totals charter option).
 */
export function billToCharterName(c: Pick<BillToCharter, 'name' | 'code'>): string {
  const name = (c.name ?? '').trim() || 'Unnamed charter';
  const code = (c.code ?? '').trim();
  return code ? `${name} (${code})` : name;
}

/** A read's row as a BillToCharterRead: found only for the row of the charter
 *  asked for; no row, or any other row, is unreadable. */
export function billToCharterReadFrom(
  row: BillToCharter | null | undefined,
  charterId: string,
): BillToCharterRead {
  if (row && row.id === charterId) return { state: 'found', charter: row };
  return { state: 'unreadable', charterId };
}

/** What a screen shows: nothing for no bill-to; else the name line and its
 *  status mark apart (the web mutes the mark), or the failed-read words. */
export interface BillToCharterDisplay {
  text: string;
  note: string;
  unreadable: boolean;
}

export function billToCharterDisplay(read: BillToCharterRead): BillToCharterDisplay | null {
  if (read.state === 'none') return null;
  if (read.state === 'unreadable') {
    return { text: PO_BILL_TO_UNREADABLE, note: '', unreadable: true };
  }
  return {
    text: billToCharterName(read.charter),
    note: recordStatusSuffix(read.charter.status),
    unreadable: false,
  };
}
