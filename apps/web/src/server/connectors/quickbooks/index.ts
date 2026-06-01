import 'server-only';

import type {
  Connector,
  ConnectionRef,
  ConnectorDeps,
  ConnectorSecrets,
  OutboxEvent,
  PushResult,
} from '@stockpilot/core';

import { env } from '@/lib/env';

import { buildBillFromReceipt, resolveVendor, round2, type BillLine } from './bill';
import { QboClient, type QboEnv } from './client';
import { buildCreditMemoFromReturn, type CreditMemoLine } from './creditmemo';
import { refreshTokens } from './oauth';

/** QBO settings persisted on the connection (see ConnectionsService). */
interface QboSettings {
  env?: QboEnv;
  accountIds?: {
    billExpense?: string;
    defaultVendorId?: string;
    returnCredit?: string;
    /** Optional generic customer to credit returns against. */
    defaultCustomerId?: string;
  };
}

/** Classify a thrown QBO error as transient (retryable) vs caller-error. */
function isRetryableQboError(e: unknown): boolean {
  const status = (e as { status?: number })?.status ?? 0;
  // 429 (rate limit) / 5xx (server) / 401 (token, refreshed next tick) are
  // transient → retryable. Other 4xx are caller errors → not retryable.
  return status === 429 || status >= 500 || status === 401;
}

/**
 * QuickBooks Online connector. ONE-WAY EXPORT ONLY (push mode):
 *  - on a posted receipt it creates a QBO Bill against the configured expense
 *    account;
 *  - on a closed return it creates a QBO CreditMemo against the configured
 *    returnCredit account.
 * It never writes QBO data back into StockPilot and never mutates
 * items/books/receiving/returns.
 *
 * Slots into the framework seams built in Tasks 1-8:
 *  - the drainer (drainer.ts) calls `refreshAuth` when the access token is near
 *    expiry, persists the rotated secret to Vault, then dispatches
 *    `handleOutboxEvent` with the injected `ConnectorDeps` (admin + mapping
 *    helpers).
 *  - the `receipt.posted` / `return.closed` outbox payloads carry NO line items,
 *    so the handler rehydrates by aggregate id before building the document.
 *  - idempotency is provided two ways: the QBO `requestid` (rcpt-<id> /
 *    return-<id>) dedupes the create on replay, and `connection_sync_log`
 *    (managed by the drainer) won't re-dispatch a row already marked success.
 */
export const quickbooksConnector: Connector = {
  id: 'quickbooks',
  modes: ['push'],
  subscribedTopics: ['receipt.posted', 'return.closed'],

  /**
   * Refresh the access token. Intuit ROTATES the refresh token on most
   * refreshes — `refreshTokens` already returns the NEW rotated value (and a
   * derived `expiresAt`), which we spread back onto the existing secrets so any
   * extra fields survive. The drainer persists the result to Vault.
   */
  async refreshAuth(_conn: ConnectionRef, secrets: ConnectorSecrets): Promise<ConnectorSecrets> {
    const t = await refreshTokens(secrets.refreshToken);
    return {
      ...secrets,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt,
    };
  },

  async handleOutboxEvent(
    event: OutboxEvent,
    conn: ConnectionRef,
    secrets: ConnectorSecrets,
    deps: ConnectorDeps,
  ): Promise<PushResult> {
    // Nothing to act on without an aggregate id — ack so the ledger marks it done.
    if (!event.aggregateId) return { ok: true };

    if (event.topic === 'receipt.posted') {
      return handleReceiptPosted(event, conn, secrets, deps);
    }
    if (event.topic === 'return.closed') {
      return handleReturnClosed(event, conn, secrets, deps);
    }
    // Not our topic — ack so the ledger marks it done.
    return { ok: true };
  },
};

/**
 * receipt.posted → QBO Bill. Rehydrates receipt → purchase_orders → suppliers
 * and receipt_lines by aggregate id (the payload has no line items), then POSTs
 * a single-line account-based Bill. Idempotent on the `rcpt-<id>` requestid.
 */
async function handleReceiptPosted(
  event: OutboxEvent,
  conn: ConnectionRef,
  secrets: ConnectorSecrets,
  deps: ConnectorDeps,
): Promise<PushResult> {
    const settings = conn.settings as QboSettings;

    // GRACEFUL CONFIG GAP: the admin must have set the expense account in the
    // Integrations panel. Without it we can't book the Bill — fail
    // non-retryably (retrying won't fix a missing config) rather than throwing.
    const billExpenseAccountId = settings.accountIds?.billExpense;
    if (!billExpenseAccountId) {
      return { ok: false, retryable: false, error: 'QuickBooks expense account not configured' };
    }

    // deps.admin is the service-role SupabaseClient (typed `unknown` in core).
    const admin = deps.admin as {
      from: (t: string) => any;
    };

    // FAIL-CLOSED reads (mirrors drainer.ts, which throws on every query error):
    // a transient DB error here must surface as a THROW so the drainer records a
    // retryable error row + backoff and re-tries next tick. If we swallowed the
    // error and `data` was null, the rehydration would be indistinguishable from
    // a genuinely-absent row → we'd ACK and the drainer would mark the export
    // `success`, silently dropping a Bill that never got created. We therefore
    // ONLY `return { ok: true }` when the read SUCCEEDED and the row is truly
    // absent (error null AND data null).
    //
    // The receipt.posted payload has no line items — rehydrate by aggregate id.
    const { data: receipt, error: receiptErr } = await admin
      .from('receipts')
      .select('id, purchase_order_id, receipt_number')
      .eq('id', event.aggregateId)
      .maybeSingle();
    if (receiptErr) throw new Error(`receipts select: ${receiptErr.message}`);
    if (!receipt) return { ok: true };

    const { data: lines, error: linesErr } = await admin
      .from('receipt_lines')
      .select('qty_accepted_base, unit_cost')
      .eq('receipt_id', receipt.id);
    if (linesErr) throw new Error(`receipt_lines select: ${linesErr.message}`);

    const { data: po, error: poErr } = receipt.purchase_order_id
      ? await admin
          .from('purchase_orders')
          .select('supplier_id')
          .eq('id', receipt.purchase_order_id)
          .maybeSingle()
      : { data: null, error: null };
    if (poErr) throw new Error(`purchase_orders select: ${poErr.message}`);

    const { data: supplier, error: supplierErr } = po?.supplier_id
      ? await admin.from('suppliers').select('id, name').eq('id', po.supplier_id).maybeSingle()
      : { data: null, error: null };
    if (supplierErr) throw new Error(`suppliers select: ${supplierErr.message}`);

    // Normalize the lines once. `?? 0` keeps a null/undefined column (or a value
    // that doesn't parse) from becoming NaN, which JSON-serializes to null and
    // QBO rejects — defensive only, the schema defaults unit_cost to 0.
    const billLines: BillLine[] = (
      (lines ?? []) as Array<{ qty_accepted_base: unknown; unit_cost: unknown }>
    ).map((l) => ({
      qtyAccepted: Number(l.qty_accepted_base) || 0,
      unitCost: Number(l.unit_cost) || 0,
    }));

    // ZERO-AMOUNT SHORT-CIRCUIT: an all-rejected receipt (every accepted qty 0)
    // has nothing to book. QBO rejects a $0 Bill with a non-retryable 4xx that
    // would burn the full retry budget before dead-lettering, so ACK instead of
    // POSTing — and skip the needless vendor-resolution round-trip. Compare the
    // ROUNDED total with the SAME round2 the Bill builder uses: a sub-cent total
    // in (0, 0.005) passes an unrounded `> 0` gate but posts a $0.00 Bill (the
    // builder rounds the Amount to 0) that QBO rejects. Gate on round2 so a
    // rounds-to-zero receipt is acked, not posted.
    const totalAmount = billLines.reduce((sum, l) => sum + l.qtyAccepted * l.unitCost, 0);
    if (round2(totalAmount) <= 0) return { ok: true };

    const qboEnv: QboEnv = settings.env ?? env.QBO_ENV;
    const client = new QboClient(conn.externalAccountId!, secrets, qboEnv);

    try {
      const vendorId = supplier
        ? await resolveVendor(client, deps, conn, supplier)
        : settings.accountIds?.defaultVendorId;

      // GRACEFUL CONFIG GAP: no supplier on the PO and no default vendor → we
      // can't address the Bill. Fail non-retryably (config, not transient).
      if (!vendorId) {
        return {
          ok: false,
          retryable: false,
          error: 'No QuickBooks vendor for receipt (no supplier mapping and no default vendor)',
        };
      }

      const body = buildBillFromReceipt({
        vendorId,
        billExpenseAccountId,
        lines: billLines,
      });

      const requestId = `rcpt-${receipt.id}`.slice(0, 50);
      const created = await client.post('/bill', body, requestId);
      const externalId = (created.Bill as { Id?: string } | undefined)?.Id;
      return { ok: true, externalId };
    } catch (e: unknown) {
      return {
        ok: false,
        retryable: isRetryableQboError(e),
        error: e instanceof Error ? e.message : 'qbo bill failed',
      };
    }
}

/**
 * return.closed → QBO CreditMemo. The payload carries NO line items (like
 * receipt.posted), so rehydrate the return + its return_lines (joined to the
 * source order line for unit_cost_at_request) by aggregate id, then POST a
 * single-line account-based CreditMemo against the configured `returnCredit`
 * account. Idempotent on the `return-<id>` requestid; the return→CreditMemo.Id
 * link is persisted via deps.putMapping(entity_type='return').
 *
 * FAIL-CLOSED reads mirror the Bill path: a transient DB error THROWS so the
 * drainer records a retryable row + backoff; we only ACK (ok:true) when the read
 * SUCCEEDED and the row is genuinely absent (error null AND data null).
 */
async function handleReturnClosed(
  event: OutboxEvent,
  conn: ConnectionRef,
  secrets: ConnectorSecrets,
  deps: ConnectorDeps,
): Promise<PushResult> {
  const settings = conn.settings as QboSettings;

  // GRACEFUL CONFIG GAP: the admin must have set the returnCredit account in
  // the Integrations panel. Without it we can't book the CreditMemo — fail
  // non-retryably (retrying won't fix a missing config), mirroring the Bill
  // expense-account gap.
  const returnCreditAccountId = settings.accountIds?.returnCredit;
  if (!returnCreditAccountId) {
    return { ok: false, retryable: false, error: 'returnCredit account not configured' };
  }

  const admin = deps.admin as { from: (t: string) => any };

  // Rehydrate the return header (org-scope is enforced by the connection; the
  // drainer only dispatches this org's events). FAIL-CLOSED: throw on a
  // transient error, ACK only on a genuinely-absent row.
  const { data: ret, error: retErr } = await admin
    .from('returns')
    .select('id, return_number')
    .eq('id', event.aggregateId)
    .maybeSingle();
  if (retErr) throw new Error(`returns select: ${retErr.message}`);
  if (!ret) return { ok: true };

  // Rehydrate the lines + each source order line's unit cost (the CreditMemo
  // amount = Σ quantity × unit_cost_at_request).
  const { data: lines, error: linesErr } = await admin
    .from('return_lines')
    .select('quantity, order_request_line:order_request_lines!order_request_line_id (unit_cost_at_request)')
    .eq('return_id', ret.id);
  if (linesErr) throw new Error(`return_lines select: ${linesErr.message}`);

  const creditLines: CreditMemoLine[] = (
    (lines ?? []) as Array<{
      quantity: unknown;
      order_request_line:
        | { unit_cost_at_request: unknown }
        | { unit_cost_at_request: unknown }[]
        | null;
    }>
  ).map((l) => {
    const ol = Array.isArray(l.order_request_line)
      ? (l.order_request_line[0] ?? null)
      : (l.order_request_line ?? null);
    return {
      quantity: Number(l.quantity) || 0,
      unitCost: Number(ol?.unit_cost_at_request) || 0,
    };
  });

  // ZERO-AMOUNT SHORT-CIRCUIT: a return whose credited total rounds to $0.00
  // (e.g. zero-cost lines) has nothing to book; QBO rejects a $0 CreditMemo
  // with a non-retryable 4xx. Gate on the SAME round2 the builder uses so a
  // sub-cent total is acked, not posted.
  const totalAmount = creditLines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
  if (round2(totalAmount) <= 0) return { ok: true };

  const qboEnv: QboEnv = settings.env ?? env.QBO_ENV;
  const client = new QboClient(conn.externalAccountId!, secrets, qboEnv);

  try {
    const body = buildCreditMemoFromReturn({
      // Optional generic customer; QBO books against the company default if absent.
      customerId: settings.accountIds?.defaultCustomerId,
      returnCreditAccountId,
      lines: creditLines,
    });

    const requestId = `return-${ret.id}`.slice(0, 50);
    const created = await client.post('/creditmemo', body, requestId);
    const externalId = (created.CreditMemo as { Id?: string } | undefined)?.Id;

    // Persist the return→CreditMemo link so the export is traceable + a future
    // pull/update path can find it. Best-effort within the success path.
    if (externalId) {
      await deps.putMapping(conn.id, conn.organizationId, 'return', ret.id, externalId);
    }
    return { ok: true, externalId };
  } catch (e: unknown) {
    return {
      ok: false,
      retryable: isRetryableQboError(e),
      error: e instanceof Error ? e.message : 'qbo credit memo failed',
    };
  }
}
