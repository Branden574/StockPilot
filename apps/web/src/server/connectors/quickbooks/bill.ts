import 'server-only';

import type { ConnectionRef, ConnectorDeps } from '@stockpilot/core';

import type { QboClient } from './client';

/**
 * receipt → QuickBooks Online Bill mapping. ONE-WAY EXPORT ONLY: these helpers
 * only build/POST a QBO Bill (and look up / create the Vendor it references) —
 * nothing here ever writes QBO data back into StockPilot.
 *
 * Mirrors the framework seams: pure builder (`buildBillFromReceipt`) so the body
 * shape is unit-testable without the network, and `resolveVendor` follows the
 * same getMapping → query → create → putMapping idempotency pattern the drainer's
 * `makeDeps` exposes (see drainer.ts), keeping the supplier↔Vendor link in
 * `connection_mappings`.
 */

/** One receipt line distilled to the two fields the Bill amount needs. */
export interface BillLine {
  qtyAccepted: number;
  unitCost: number;
}

export interface BuildBillArgs {
  vendorId: string;
  billExpenseAccountId: string;
  lines: BillLine[];
}

/** Minimal supplier shape used to resolve / create the QBO Vendor. */
export interface SupplierRef {
  id: string;
  name: string;
}

/** Round to 2 decimal places (currency), avoiding binary-float drift. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build the QBO Bill request body from a posted receipt's accepted lines.
 *
 * v1 collapses every receipt line into a SINGLE account-based expense line: the
 * aggregate accepted-cost (`Σ qtyAccepted × unitCost`, rounded to 2-dp) booked
 * against the configured expense account. One line keeps the export simple and
 * matches the account-based (not item-based) model — per-line item mapping is a
 * deliberate future extension, not a v1 requirement. Pure function (no I/O).
 */
export function buildBillFromReceipt(args: BuildBillArgs): {
  VendorRef: { value: string };
  Line: Array<{
    DetailType: 'AccountBasedExpenseLineDetail';
    Amount: number;
    AccountBasedExpenseLineDetail: { AccountRef: { value: string } };
  }>;
} {
  const amount = round2(
    args.lines.reduce((sum, l) => sum + l.qtyAccepted * l.unitCost, 0),
  );
  return {
    VendorRef: { value: args.vendorId },
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: amount,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: args.billExpenseAccountId },
        },
      },
    ],
  };
}

/** Escape single quotes for a QBO query string literal (`'` → `''`). */
function escapeQuery(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Resolve a StockPilot supplier to a QBO Vendor id, creating + persisting the
 * mapping on first use. Idempotent across drain runs:
 *  1. `deps.getMapping(conn.id,'supplier',supplier.id)` — fast path, no QBO call.
 *  2. else query QBO for an existing Vendor by DisplayName (single-quotes
 *     escaped) and reuse it if found.
 *  3. else create a new Vendor.
 * In cases 2/3 the resolved id is written back via `deps.putMapping` so the next
 * receipt for the same supplier short-circuits at step 1.
 */
export async function resolveVendor(
  client: QboClient,
  deps: ConnectorDeps,
  conn: ConnectionRef,
  supplier: SupplierRef,
): Promise<string> {
  const mapped = await deps.getMapping(conn.id, 'supplier', supplier.id);
  if (mapped) return mapped.externalId;

  // Look for an existing Vendor by display name before creating a duplicate.
  const queryRes = await client.query(
    `select * from Vendor where DisplayName = '${escapeQuery(supplier.name)}'`,
  );
  const found = (queryRes.QueryResponse as { Vendor?: Array<{ Id?: string }> } | undefined)
    ?.Vendor;
  let vendorId = found?.[0]?.Id;

  if (!vendorId) {
    // Idempotency requestid for the Vendor create. Put the supplier id FIRST so
    // the Intuit 50-char requestid cap can't truncate it: 'vendor-'(7) +
    // supplier.id(36) + '-'(1) = 44, leaving the conn id as a 6-char tail
    // discriminator. Ordering it conn-first would slice the supplier UUID down
    // to ~6 chars and two suppliers sharing a 6-hex prefix could collide.
    const requestId = `vendor-${supplier.id}-${conn.id}`.slice(0, 50);
    const created = await client.post('/vendor', { DisplayName: supplier.name }, requestId);
    vendorId = (created.Vendor as { Id?: string } | undefined)?.Id;
    if (!vendorId) {
      throw new Error('QBO vendor create returned no Id');
    }
  }

  await deps.putMapping(conn.id, conn.organizationId, 'supplier', supplier.id, vendorId);
  return vendorId;
}
