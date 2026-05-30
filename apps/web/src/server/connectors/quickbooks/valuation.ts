import 'server-only';

import type { ConnectionRef } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import type { QboClient } from './client';

/**
 * Monthly inventory-valuation JournalEntry export. ONE-WAY EXPORT ONLY: this
 * computes StockPilot's current total inventory value and pushes the DELTA vs
 * the last snapshot to QuickBooks Online as a balanced journal entry — it never
 * reads QBO data back into StockPilot and never mutates items/books/receiving.
 *
 * Posted at most once per calendar month per connection (the every-5-min
 * drainer cron gates on `settings.lastValuationMonth`), so no second cron is
 * needed (spec open-item 3).
 */

/** Round to 2 decimal places (currency), avoiding binary-float drift. Mirrors bill.ts. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface BuildValuationJEArgs {
  /** current total value − last snapshot. Positive = inventory grew. */
  deltaValue: number;
  inventoryAssetId: string;
  valuationOffsetId: string;
  /** Period-end posting date as YYYY-MM-DD. */
  txnDate: string;
}

/** One QBO JournalEntry line. */
interface JournalEntryLine {
  DetailType: 'JournalEntryLineDetail';
  Amount: number;
  JournalEntryLineDetail: {
    PostingType: 'Debit' | 'Credit';
    AccountRef: { value: string };
  };
}

export interface JournalEntryBody {
  TxnDate: string;
  Line: JournalEntryLine[];
}

/**
 * Build a BALANCED QBO JournalEntry for an inventory-valuation delta.
 *
 * A positive delta (inventory grew) DEBITs the inventory-asset account and
 * CREDITs the valuation-offset account; a negative delta swaps the two. Either
 * way `Amount = |delta|` on both lines, so Σ debits === Σ credits. A zero delta
 * has nothing to post and returns `null`. Pure function (no I/O). Never posts
 * against A/P or A/R accounts (spec).
 */
export function buildInventoryValuationJE(args: BuildValuationJEArgs): JournalEntryBody | null {
  const { deltaValue, inventoryAssetId, valuationOffsetId, txnDate } = args;
  if (deltaValue === 0) return null;

  const amount = Math.abs(deltaValue);
  // delta>0: Debit asset / Credit offset. delta<0: swap (Debit offset / Credit asset).
  const debitAccountId = deltaValue > 0 ? inventoryAssetId : valuationOffsetId;
  const creditAccountId = deltaValue > 0 ? valuationOffsetId : inventoryAssetId;

  return {
    TxnDate: txnDate,
    Line: [
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: debitAccountId } },
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: creditAccountId } },
      },
    ],
  };
}

/** Minimal admin (service-role) seam — `from(table)` query builder. */
type AdminClient = { from: (t: string) => any };

/** YYYY-MM of a Date in UTC. */
function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** YYYY-MM-DD of a Date in UTC. */
function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Current total inventory value for an org: `Σ quantity_on_hand × unit_cost`
 * over active, non-deleted, non-rental items.
 *
 * ReportsService.inventoryValuation() encodes the same logic but requires a
 * user-scoped ServiceContext (RLS supabase + organizationId resolved from the
 * session) — it is NOT cleanly callable for an arbitrary org id from the
 * service-role cron. So we re-run the same query filters here against the admin
 * client, scoped explicitly by organization_id. Filters mirror reports.ts
 * exactly: deleted_at IS NULL, status='active', is_rental=false.
 */
async function currentInventoryValue(admin: AdminClient, organizationId: string): Promise<number> {
  const { data, error } = await admin
    .from('inventory_items')
    .select('quantity_on_hand, unit_cost')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .eq('is_rental', false)
    .limit(10_000);
  if (error) throw new Error(`inventory_items valuation select: ${error.message}`);

  let total = 0;
  for (const r of (data ?? []) as Array<{ quantity_on_hand: unknown; unit_cost: unknown }>) {
    const qty = Number(r.quantity_on_hand) || 0;
    const cost = Number(r.unit_cost) || 0;
    total += qty * cost;
  }
  return total;
}

/**
 * Post the monthly inventory-valuation JournalEntry for one connection, at most
 * once per calendar month. Called by the drainer cron AFTER runDrain — a failure
 * here must NOT fail the drain (the caller wraps this in try/catch).
 *
 * Flow:
 *  1. Skip if this connection already posted for the current calendar month
 *     (`settings.lastValuationMonth === YYYY-MM`).
 *  2. Compute the org's current total inventory value; delta = round2(current −
 *     lastSnapshot). Snapshot defaults to 0 on first run.
 *  3. GRACEFUL CONFIG GAP: if the inventoryAsset / valuationOffset accounts
 *     aren't configured in the Integrations panel, record a `last_error` note
 *     and skip — never crash the cron or block the drain.
 *  4. If delta !== 0, POST a balanced JE (requestid `val-<realmId>-<month>` for
 *     idempotency — a replay never double-posts).
 *  5. Update `settings` (merge, do NOT clobber accountIds): snapshot=current,
 *     lastValuationMonth=month, lastValuationAt=now.
 *
 * Note: the snapshot + month are advanced even when delta is 0 (nothing to post
 * but the period is "done"), and only after a successful POST otherwise — so a
 * failed POST leaves the month un-stamped and retries next tick.
 */
export async function maybePostMonthlyValuation(
  admin: AdminClient,
  conn: ConnectionRef,
  client: QboClient,
  now: Date,
): Promise<void> {
  const month = monthKey(now);
  const settings = (conn.settings ?? {}) as {
    accountIds?: { inventoryAsset?: string; valuationOffset?: string };
    lastValuationSnapshotValue?: number;
    lastValuationMonth?: string;
  };

  // 1. Once per calendar month per connection.
  if (settings.lastValuationMonth === month) return;

  const inventoryAssetId = settings.accountIds?.inventoryAsset;
  const valuationOffsetId = settings.accountIds?.valuationOffset;

  // 3. GRACEFUL CONFIG GAP — record a note and skip without blocking the drain.
  if (!inventoryAssetId || !valuationOffsetId) {
    await admin
      .from('org_connections')
      .update({
        last_error: 'Inventory valuation skipped: inventoryAsset/valuationOffset account not configured',
        updated_at: now.toISOString(),
      })
      .eq('id', conn.id);
    return;
  }

  // 2. current value + delta vs last snapshot.
  const current = round2(await currentInventoryValue(admin, conn.organizationId));
  const lastSnapshot = Number(settings.lastValuationSnapshotValue) || 0;
  const delta = round2(current - lastSnapshot);

  // 4. Post the balanced JE when there's a non-zero delta.
  if (delta !== 0) {
    const body = buildInventoryValuationJE({
      deltaValue: delta,
      inventoryAssetId,
      valuationOffsetId,
      txnDate: dateKey(now),
    });
    if (body) {
      const requestId = `val-${conn.externalAccountId}-${month}`.slice(0, 50);
      await client.post('/journalentry', body, requestId);
    }
  }

  // 5. Merge the snapshot bookkeeping into settings WITHOUT clobbering accountIds.
  const nextSettings = {
    ...settings,
    lastValuationSnapshotValue: current,
    lastValuationMonth: month,
    lastValuationAt: now.toISOString(),
  };
  const { error: updErr } = await admin
    .from('org_connections')
    .update({ settings: nextSettings, last_synced_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', conn.id);
  if (updErr) {
    // The JE may already have posted; report so the unstamped month is visible
    // (next tick re-posts only if the delta changed — the same-period requestid
    // guards a duplicate). Never throw: this must not fail the drain.
    void reportError(new Error(`org_connections valuation settings update: ${updErr.message}`), {
      tag: 'cron.drain-outbox.valuation',
      extra: { connectionId: conn.id },
    });
  }
}
