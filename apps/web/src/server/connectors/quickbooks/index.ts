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

import { buildBillFromReceipt, resolveVendor } from './bill';
import { QboClient, type QboEnv } from './client';
import { refreshTokens } from './oauth';

/**
 * QuickBooks Online connector. ONE-WAY EXPORT ONLY (push mode): on a posted
 * receipt it creates a QBO Bill against the configured expense account, never
 * writing QBO data back into StockPilot and never mutating items/books/receiving.
 *
 * Slots into the framework seams built in Tasks 1-8:
 *  - the drainer (drainer.ts) calls `refreshAuth` when the access token is near
 *    expiry, persists the rotated secret to Vault, then dispatches
 *    `handleOutboxEvent` with the injected `ConnectorDeps` (admin + mapping
 *    helpers).
 *  - the `receipt.posted` outbox payload carries NO line items, so the handler
 *    rehydrates receipt → purchase_orders → suppliers and receipt_lines by
 *    aggregate id (= receipt id) before building the Bill.
 *  - idempotency is provided two ways: the QBO `requestid` (rcpt-<id>) dedupes
 *    the Bill create on replay, and `connection_sync_log` (managed by the
 *    drainer) won't re-dispatch a row already marked success.
 */
export const quickbooksConnector: Connector = {
  id: 'quickbooks',
  modes: ['push'],
  subscribedTopics: ['receipt.posted'],

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
    // Not our topic / nothing to act on — ack so the ledger marks it done.
    if (event.topic !== 'receipt.posted' || !event.aggregateId) return { ok: true };

    const settings = conn.settings as {
      env?: QboEnv;
      accountIds?: { billExpense?: string; defaultVendorId?: string };
    };

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

    // The receipt.posted payload has no line items — rehydrate by aggregate id.
    const { data: receipt } = await admin
      .from('receipts')
      .select('id, purchase_order_id, receipt_number')
      .eq('id', event.aggregateId)
      .maybeSingle();
    if (!receipt) return { ok: true };

    const { data: lines } = await admin
      .from('receipt_lines')
      .select('qty_accepted_base, unit_cost')
      .eq('receipt_id', receipt.id);

    const { data: po } = receipt.purchase_order_id
      ? await admin
          .from('purchase_orders')
          .select('supplier_id')
          .eq('id', receipt.purchase_order_id)
          .maybeSingle()
      : { data: null };

    const { data: supplier } = po?.supplier_id
      ? await admin.from('suppliers').select('id, name').eq('id', po.supplier_id).maybeSingle()
      : { data: null };

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
        lines: (lines ?? []).map((l: { qty_accepted_base: unknown; unit_cost: unknown }) => ({
          qtyAccepted: Number(l.qty_accepted_base),
          unitCost: Number(l.unit_cost),
        })),
      });

      const requestId = `rcpt-${receipt.id}`.slice(0, 50);
      const created = await client.post('/bill', body, requestId);
      const externalId = (created.Bill as { Id?: string } | undefined)?.Id;
      return { ok: true, externalId };
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status ?? 0;
      // 429 (rate limit) / 5xx (server) / 401 (token, refreshed next tick) are
      // transient → retryable. Other 4xx are caller errors → not retryable.
      const retryable = status === 429 || status >= 500 || status === 401;
      return { ok: false, retryable, error: e instanceof Error ? e.message : 'qbo bill failed' };
    }
  },
};
