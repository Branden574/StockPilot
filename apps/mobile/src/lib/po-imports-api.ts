import { api } from './api';
import {
  extractApiErrorMessage,
  normalizeLineMatches,
  type ApproveLineOverride,
  type MatchCandidate,
} from './po-import-approve';

/**
 * Typed wrappers over the mobile api() client for the PO-import WRITE flow —
 * the native parity for the web review page's server actions. All five routes
 * are the Bearer /api/v1/po-imports/[id]/* set from the 2026-07-18 parity
 * plan's PINNED contract; each reuses PoImportsService server-side, so
 * 'purchase_orders:manage' (and the po_imports module gate) is enforced there.
 * Reads stay on Supabase/RLS like the rest of the app — these are writes only.
 *
 * Every wrapper throws a clean Error carrying the server's friendly message
 * (extractApiErrorMessage) so screens can render it inline directly.
 */

export interface ApprovePoImportBody {
  warehouseId: string;
  vendorId: string;
  locationId: string;
  charterId?: string | null;
  expectedAt?: string | null;
  lineOverrides?: ApproveLineOverride[];
}

/** Approve → creates the real PO; returns its id for the success redirect. */
export async function approvePoImport(
  importId: string,
  body: ApprovePoImportBody,
): Promise<{ poId: string }> {
  try {
    // Approval fans out server-side (item re-resolution, PO + lines + charges
    // inserts) — give it headroom past the default 20s client timeout.
    const res = await api<{ ok: boolean; poId: string }>(
      `/api/v1/po-imports/${importId}/approve`,
      { method: 'POST', body, timeoutMs: 60_000 },
    );
    return { poId: res.poId };
  } catch (e) {
    throw new Error(extractApiErrorMessage(e, 'Could not approve this import.'));
  }
}

/** Cancel a non-terminal import (server refuses approved/canceled). */
export async function cancelPoImport(importId: string): Promise<void> {
  try {
    await api(`/api/v1/po-imports/${importId}/cancel`, { method: 'POST' });
  } catch (e) {
    throw new Error(extractApiErrorMessage(e, 'Could not cancel this import.'));
  }
}

/** (Re-)run the parser on an uploaded/failed import. */
export async function parsePoImport(importId: string): Promise<void> {
  try {
    // Parsing downloads the file from Storage and runs the parser — allow the
    // same headroom the scan flow gives its server round-trip.
    await api(`/api/v1/po-imports/${importId}/parse`, { method: 'POST', timeoutMs: 70_000 });
  } catch (e) {
    throw new Error(extractApiErrorMessage(e, 'Could not re-parse this import.'));
  }
}

/**
 * Duplicate-candidate suggestions for unmatched lines, keyed by line id.
 * Normalized defensively (see normalizeLineMatches) so a shape surprise
 * degrades to "no suggestions" rather than crashing the approve sheet.
 */
export async function fetchLineMatches(
  importId: string,
  lineIds: string[],
): Promise<Record<string, MatchCandidate[]>> {
  try {
    const res = await api<unknown>(`/api/v1/po-imports/${importId}/line-matches`, {
      method: 'POST',
      body: { lineIds },
    });
    return normalizeLineMatches(res);
  } catch (e) {
    throw new Error(extractApiErrorMessage(e, 'Could not load match suggestions.'));
  }
}

export interface CreateItemsFromLinesBody {
  lineIds: string[];
  vendorId: string;
  warehouseId: string | null;
  charterId?: string | null;
  locationId?: string | null;
}

/**
 * Batch-create inventory items for the lines the user decided to CREATE.
 * The server maps each line to its new item (match_status='mapped'), so a
 * following approve sees them resolved with no lineOverride needed.
 */
export async function createItemsFromLines(
  importId: string,
  body: CreateItemsFromLinesBody,
): Promise<void> {
  try {
    await api(`/api/v1/po-imports/${importId}/create-items`, {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    });
  } catch (e) {
    throw new Error(extractApiErrorMessage(e, 'Could not create items for these lines.'));
  }
}
