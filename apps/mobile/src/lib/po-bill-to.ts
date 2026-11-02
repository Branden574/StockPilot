/**
 * The charter a purchase order is billed to, on the phone's PO screen (B56):
 * purchase_orders.charter_id, which the web page and the PO PDF name under
 * "Bill to". The words come from @stockpilot/core (billToCharterDisplay), so
 * the three read the same. Never the charter that owns an item's stock.
 *
 * A label read, kept apart from the PO read: a charters embed that failed
 * would fail the whole PO read and show "Could not load this PO", which blocks
 * receiving, while this read only loses one line. It is the organization's
 * charter by id at ANY status (a charter archived since still billed the PO),
 * it is bounded (the app's client has no fetch timeout, so one hung request
 * would hold the screen's spinner), and it never rejects: an error, no row, a
 * rejection or the bound passing is 'unreadable', warned once.
 *
 * Pure: no React Native import, no Supabase client. Do not import ./supabase
 * here (supabase.ts pulls in expo-secure-store); the screen passes its client.
 */

import {
  PO_BILL_TO_LABEL,
  billToCharterDisplay,
  billToCharterReadFrom,
  type BillToCharter,
  type BillToCharterRead,
} from '@stockpilot/core';

import { withTimeout } from './account-eviction';

export type { BillToCharterRead } from '@stockpilot/core';

/** How long the screen waits for the charter before it says it could not be
 *  loaded (the same 8 s as the account probe, its own constant). */
export const PO_BILL_TO_WAIT_MS = 8_000;

/** A minimal client shape (the screen passes `supabase`, the tests a fake). */
export interface PoBillToClient {
  from(table: string): unknown;
}

interface CharterTable {
  select(columns: string): CharterChain;
}

interface CharterChain {
  eq(column: string, value: unknown): CharterChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * The bill-to charter of a purchase order: none for no charter id (nothing is
 * read), else found or unreadable. Never rejects; waits at most `waitMs`.
 */
export async function readPoBillToCharter(
  client: PoBillToClient,
  orgId: string,
  charterId: string | null,
  waitMs: number = PO_BILL_TO_WAIT_MS,
): Promise<BillToCharterRead> {
  if (!charterId) return { state: 'none' };
  const unreadable: BillToCharterRead = { state: 'unreadable', charterId };
  // Once answered (or given up on), a later failure is not warned again.
  let done = false;
  const fail = (why: unknown): BillToCharterRead => {
    if (!done) {
      done = true;
      console.warn('[po] bill-to charter read failed', why);
    }
    return unreadable;
  };
  const work = (async (): Promise<BillToCharterRead> => {
    try {
      const { data, error } = await (client.from('charters') as CharterTable)
        .select('id, name, code, status')
        .eq('organization_id', orgId)
        .eq('id', charterId)
        .maybeSingle();
      if (error) return fail(error.message);
      const read = billToCharterReadFrom(data as BillToCharter | null, charterId);
      return read.state === 'unreadable' ? fail('no charter row') : read;
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  })();
  const answer = await withTimeout<BillToCharterRead | null>(work, waitMs, null);
  if (answer === null) return fail(`no answer in ${waitMs} ms`);
  done = true;
  return answer;
}

/**
 * The header line, 'Bill to: North Campus (NC) (archived)' or 'Bill to: Could
 * not be loaded'; null when the PO on screen has no charter, or when the read
 * is for another charter id, so a read left from another PO can never name
 * this one's bill-to.
 */
export function poBillToLine(
  headerCharterId: string | null,
  read: BillToCharterRead,
): string | null {
  if (!headerCharterId) return null;
  if (read.state === 'found' && read.charter.id !== headerCharterId) return null;
  if (read.state === 'unreadable' && read.charterId !== headerCharterId) return null;
  const shown = billToCharterDisplay(read);
  if (!shown) return null;
  return `${PO_BILL_TO_LABEL}: ${shown.text}${shown.note}`;
}
