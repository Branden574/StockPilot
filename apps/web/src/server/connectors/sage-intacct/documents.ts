import 'server-only';

import type { ConnectionRef, ConnectorDeps } from '@stockpilot/core';

import type { IntacctClient } from './client';

/**
 * StockPilot → Sage Intacct document builders + vendor resolution.
 *
 * Pure builders (no I/O) so body shapes are unit-testable, mirroring the QBO
 * bill.ts split. Intacct specifics that differ from QBO:
 *
 *  - Purchasing documents are TYPED BY a per-tenant "transaction definition"
 *    (customers rename/customize them), so the definition name is connection
 *    config, defaulting to Intacct's stock "Purchase Order".
 *  - Document lines are OWNED OBJECTS — only ever written through the header
 *    document body, never as a separate create.
 *  - Lines are item-based: a single-line total-amount PO needs a configured
 *    non-inventory item id (`defaultItemId`) to book against.
 *  - We deliberately DO NOT auto-create vendors in Intacct (unlike QBO):
 *    creating master data in a customer's ERP uninvited is a governance
 *    foot-gun. We resolve by exact name, else fall back to the configured
 *    default vendor, else fail non-retryably with a clear config message.
 *
 * ⚠ PENDING SANDBOX VERIFICATION: field names follow the published REST v1
 * reference (docs.intacct.com / developer.sage.com); verify + tune on the
 * sandbox company once the developer license exists.
 */

/** Round to 2 decimal places (currency), avoiding binary-float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface BuildIntacctPoArgs {
  vendorId: string;
  /** Per-tenant purchasing transaction definition name (config). */
  txnDefinition: string;
  /** Non-inventory item the single total line books against (config). */
  defaultItemId: string;
  /** PO total, pre-rounding. */
  amount: number;
  /** StockPilot PO number — becomes the Intacct document number/reference. */
  documentNumber: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
}

/** Build the Intacct purchasing-document body for a StockPilot PO. */
export function buildIntacctPurchaseOrder(args: BuildIntacctPoArgs): Record<string, unknown> {
  return {
    txnDefinition: { name: args.txnDefinition },
    documentNumber: args.documentNumber,
    createdDate: args.date,
    vendor: { id: args.vendorId },
    // Single item-based line carrying the PO total — same v1 simplification as
    // the QBO account-based Bill/PO (per-line item mapping is a future
    // extension, not a v1 requirement).
    lines: [
      {
        item: { id: args.defaultItemId },
        quantity: 1,
        price: round2(args.amount),
      },
    ],
  };
}

export interface ReturnCreditLine {
  quantity: number;
  unitCost: number;
}

export interface BuildIntacctJournalArgs {
  /** GL journal symbol (per-tenant config; Intacct ships 'GJ'). */
  journalSymbol: string;
  /** GL account CREDITED by the returned value. */
  returnCreditAccountId: string;
  /** GL account DEBITED to balance (returned goods re-enter asset value). */
  inventoryAssetAccountId: string;
  lines: ReturnCreditLine[];
  /** ISO date (YYYY-MM-DD). */
  postingDate: string;
  description: string;
}

/**
 * Build a BALANCED two-line Intacct GL journal entry for a closed return —
 * the same value-only posting the QBO connector books (a return credits the
 * returned inventory's VALUE against GL accounts; no customer involved, so a
 * journal entry — not an AP/AR document — is the correct mapping in Intacct
 * too).
 */
export function buildReturnJournalEntry(args: BuildIntacctJournalArgs): Record<string, unknown> {
  const amount = round2(args.lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
  return {
    journal: { id: args.journalSymbol },
    postingDate: args.postingDate,
    description: args.description,
    lines: [
      {
        glAccount: { id: args.inventoryAssetAccountId },
        txnType: 'debit',
        txnAmount: amount,
      },
      {
        glAccount: { id: args.returnCreditAccountId },
        txnType: 'credit',
        txnAmount: amount,
      },
    ],
  };
}

/** Minimal supplier shape used to resolve the Intacct vendor. */
export interface SupplierRef {
  id: string;
  name: string;
}

/**
 * Resolve a StockPilot supplier to an Intacct vendor id. Idempotent across
 * drain runs via connection_mappings:
 *  1. `deps.getMapping(conn.id,'supplier',supplier.id)` — fast path, no API call.
 *  2. else query Intacct for an existing vendor by exact name and persist the
 *     mapping when found.
 *  3. else return null — the caller falls back to the configured default
 *     vendor or fails non-retryably. We never create vendors in the ERP.
 */
export async function resolveIntacctVendor(
  client: IntacctClient,
  deps: ConnectorDeps,
  conn: ConnectionRef,
  supplier: SupplierRef,
): Promise<string | null> {
  const mapped = await deps.getMapping(conn.id, 'supplier', supplier.id);
  if (mapped) return mapped.externalId;

  const page = await client.queryPage({
    object: 'accounts-payable/vendor',
    fields: ['id', 'name'],
    filters: [{ $eq: { name: supplier.name } }],
    size: 2,
  });
  const vendorId =
    typeof page.records[0]?.id === 'string' ? (page.records[0].id as string) : null;
  if (!vendorId) return null;

  await deps.putMapping(conn.id, conn.organizationId, 'supplier', supplier.id, vendorId);
  return vendorId;
}
