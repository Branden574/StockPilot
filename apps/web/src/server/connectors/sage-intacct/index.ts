import 'server-only';

import type {
  Connector,
  ConnectionRef,
  ConnectorDeps,
  ConnectorSecrets,
  OutboxEvent,
  PushResult,
} from '@stockpilot/core';

import { IntacctClient } from './client';
import {
  buildIntacctPurchaseOrder,
  buildReturnJournalEntry,
  resolveIntacctVendor,
  round2,
  type ReturnCreditLine,
} from './documents';
import { refreshTokens } from './oauth';

/** Intacct settings persisted on the connection (Integrations panel). */
interface IntacctSettings {
  intacct?: {
    /** Per-tenant purchasing transaction definition (default 'Purchase Order'). */
    poTxnDefinition?: string;
    /** Non-inventory item id the single-line PO total books against. REQUIRED for PO push. */
    defaultItemId?: string;
    /** Fallback vendor id when a supplier has no Intacct match. */
    defaultVendorId?: string;
    /** GL journal symbol for return value entries (default 'GJ'). */
    journalSymbol?: string;
  };
  accountIds?: {
    /** GL account credited by a closed return's value (same key as QBO). */
    returnCredit?: string;
    /** GL account debited to balance (same key as QBO). */
    inventoryAsset?: string;
  };
}

/** Classify a thrown Intacct error as transient (retryable) vs caller-error. */
function isRetryableIntacctError(e: unknown): boolean {
  const status = (e as { status?: number })?.status ?? 0;
  // 429 (rate limit) / 5xx (server) / 401 (token, refreshed next tick) are
  // transient → retryable. Other 4xx are caller errors → not retryable.
  return status === 429 || status >= 500 || status === 401;
}

/**
 * Sage Intacct connector — push mode mirrors the QuickBooks connector
 * one-for-one (same topics, same fail-closed rehydration, same zero-amount
 * acks, same graceful config gaps):
 *
 *  - purchase_order.ordered → Intacct purchasing document (typed by the
 *    configured transaction definition), single item-based line for the total.
 *  - return.closed → BALANCED two-line GL journal entry (credit returnCredit,
 *    debit inventoryAsset) — value-only, no customer/vendor involved.
 *
 * The "migrate from Intacct" import deliberately does NOT live in this file
 * (and this connector declares push mode ONLY): importing items must run in a
 * USER context through InventoryService.create so initial quantities post
 * ledger-correct movements and permissions are enforced — see
 * services/intacct-import.ts. If a scheduled pull-runner ever exists, add
 * 'pull' + a `scheduledPull` implementation together.
 *
 * Idempotency: Intacct REST v1 has no `requestid` query param equivalent, so
 * replay-protection rests on (a) the drainer's connection_sync_log never
 * re-dispatching a success row and (b) the connection_mappings row written
 * after each successful create (checked before POSTing — see the mapping
 * short-circuits below). A crash BETWEEN the POST and putMapping can still
 * duplicate on retry — acceptable v1 risk, called out for sandbox testing.
 *
 * ⚠ PENDING SANDBOX VERIFICATION (needs the owner's Sage developer license).
 */
export const sageIntacctConnector: Connector = {
  id: 'sage_intacct',
  modes: ['push'],
  subscribedTopics: ['purchase_order.ordered', 'return.closed'],

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
    if (!event.aggregateId) return { ok: true };

    if (event.topic === 'purchase_order.ordered') {
      return handlePurchaseOrderOrdered(event, conn, secrets, deps);
    }
    if (event.topic === 'return.closed') {
      return handleReturnClosed(event, conn, secrets, deps);
    }
    return { ok: true };
  },
};

/**
 * purchase_order.ordered → Intacct purchasing document. Rehydrates the PO by
 * aggregate id (payload carries no lines), resolves the vendor (mapping →
 * exact-name query → configured default; we never create ERP vendors), and
 * POSTs a single-line document for the total. FAIL-CLOSED reads mirror the QBO
 * connector: throw on a transient DB error so the drainer retries; ACK only
 * when the read succeeded and the row is genuinely absent.
 */
async function handlePurchaseOrderOrdered(
  event: OutboxEvent,
  conn: ConnectionRef,
  secrets: ConnectorSecrets,
  deps: ConnectorDeps,
): Promise<PushResult> {
  const settings = conn.settings as IntacctSettings;

  // GRACEFUL CONFIG GAP: an Intacct purchasing line is item-based — without a
  // configured non-inventory item we cannot book the total. Non-retryable.
  const defaultItemId = settings.intacct?.defaultItemId;
  if (!defaultItemId) {
    return { ok: false, retryable: false, error: 'Intacct default item not configured' };
  }
  // `||` (not `??`): the settings card stores '' for fields left blank, and
  // the placeholder implies blank = this default. '' would otherwise POST
  // `txnDefinition: { name: '' }` — a non-retryable 400 on every push.
  const txnDefinition = settings.intacct?.poTxnDefinition || 'Purchase Order';

  const admin = deps.admin as { from: (t: string) => any };

  // IDEMPOTENCY SHORT-CIRCUIT: already exported on a previous (crashed) run.
  const existing = await deps.getMapping(conn.id, 'purchase_order', event.aggregateId);
  if (existing) return { ok: true, externalId: existing.externalId };

  const { data: po, error: poErr } = await admin
    .from('purchase_orders')
    .select('id, po_number, supplier_id, total')
    .eq('id', event.aggregateId)
    .eq('organization_id', conn.organizationId) // defense-in-depth: tenant-scope the rehydration
    .maybeSingle();
  if (poErr) throw new Error(`purchase_orders select: ${poErr.message}`);
  if (!po) return { ok: true };

  const { data: supplier, error: supplierErr } = po.supplier_id
    ? await admin
        .from('suppliers')
        .select('id, name')
        .eq('id', po.supplier_id)
        .eq('organization_id', conn.organizationId) // defense-in-depth: tenant-scope the rehydration
        .maybeSingle()
    : { data: null, error: null };
  if (supplierErr) throw new Error(`suppliers select: ${supplierErr.message}`);

  // ZERO-AMOUNT SHORT-CIRCUIT: nothing to book; gate on the SAME round2 the
  // builder uses so a sub-cent total is acked, not posted.
  const amount = Number(po.total) || 0;
  if (round2(amount) <= 0) return { ok: true };

  const client = new IntacctClient(secrets);

  try {
    const vendorId = supplier
      ? ((await resolveIntacctVendor(client, deps, conn, supplier)) ??
        settings.intacct?.defaultVendorId)
      : settings.intacct?.defaultVendorId;
    if (!vendorId) {
      return {
        ok: false,
        retryable: false,
        error: 'No Intacct vendor for PO (no name match and no default vendor configured)',
      };
    }

    const body = buildIntacctPurchaseOrder({
      vendorId,
      txnDefinition,
      defaultItemId,
      amount,
      documentNumber: String(po.po_number ?? po.id),
      date: new Date().toISOString().slice(0, 10),
    });
    const created = await client.post('/objects/purchasing/document', body);
    const externalId = extractCreatedId(created);

    // Persist the PO→document link BEFORE acking so a drainer crash after the
    // POST can't re-create on the next run (the short-circuit above).
    if (externalId) {
      await deps.putMapping(
        conn.id,
        conn.organizationId,
        'purchase_order',
        po.id,
        externalId,
      );
    }
    return { ok: true, externalId: externalId ?? undefined };
  } catch (e: unknown) {
    return {
      ok: false,
      retryable: isRetryableIntacctError(e),
      error: e instanceof Error ? e.message : 'intacct purchase order failed',
    };
  }
}

/**
 * return.closed → Intacct GL journal entry (value-only; same mapping rationale
 * as the QBO JournalEntry — a return books inventory VALUE against GL accounts,
 * no customer/vendor document is correct). FAIL-CLOSED reads as above.
 */
async function handleReturnClosed(
  event: OutboxEvent,
  conn: ConnectionRef,
  secrets: ConnectorSecrets,
  deps: ConnectorDeps,
): Promise<PushResult> {
  const settings = conn.settings as IntacctSettings;

  const returnCreditAccountId = settings.accountIds?.returnCredit;
  if (!returnCreditAccountId) {
    return { ok: false, retryable: false, error: 'returnCredit account not configured' };
  }
  const inventoryAssetAccountId = settings.accountIds?.inventoryAsset;
  if (!inventoryAssetAccountId) {
    return { ok: false, retryable: false, error: 'inventoryAsset account not configured' };
  }
  // `||` (not `??`): blank-saved settings store '' — see the PO handler.
  const journalSymbol = settings.intacct?.journalSymbol || 'GJ';

  const admin = deps.admin as { from: (t: string) => any };

  // IDEMPOTENCY SHORT-CIRCUIT (no Intacct requestid equivalent — see header).
  const existing = await deps.getMapping(conn.id, 'return', event.aggregateId);
  if (existing) return { ok: true, externalId: existing.externalId };

  const { data: ret, error: retErr } = await admin
    .from('returns')
    .select('id, return_number')
    .eq('id', event.aggregateId)
    .eq('organization_id', conn.organizationId) // defense-in-depth: tenant-scope the rehydration
    .maybeSingle();
  if (retErr) throw new Error(`returns select: ${retErr.message}`);
  if (!ret) return { ok: true };

  const { data: lines, error: linesErr } = await admin
    .from('return_lines')
    .select(
      'quantity, order_request_line:order_request_lines!order_request_line_id (unit_cost_at_request)',
    )
    .eq('return_id', ret.id);
  if (linesErr) throw new Error(`return_lines select: ${linesErr.message}`);

  const creditLines: ReturnCreditLine[] = (
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

  const totalAmount = creditLines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
  if (round2(totalAmount) <= 0) return { ok: true };

  const client = new IntacctClient(secrets);

  try {
    const body = buildReturnJournalEntry({
      journalSymbol,
      returnCreditAccountId,
      inventoryAssetAccountId,
      lines: creditLines,
      postingDate: new Date().toISOString().slice(0, 10),
      description: `StockPilot return ${String(ret.return_number ?? ret.id)}`,
    });
    const created = await client.post('/objects/general-ledger/journal-entry', body);
    const externalId = extractCreatedId(created);

    if (externalId) {
      await deps.putMapping(conn.id, conn.organizationId, 'return', ret.id, externalId);
    }
    return { ok: true, externalId: externalId ?? undefined };
  } catch (e: unknown) {
    return {
      ok: false,
      retryable: isRetryableIntacctError(e),
      error: e instanceof Error ? e.message : 'intacct return journal entry failed',
    };
  }
}

/**
 * Pull the created record's id out of an Intacct create response. REST v1
 * envelopes results under `ia::result` ({ key, id, href }); tolerate bare
 * shapes defensively. Returns null when unrecognizable (caller still acks —
 * the create succeeded — but skips the mapping write).
 */
function extractCreatedId(res: Record<string, unknown>): string | null {
  const result = (res['ia::result'] ?? res.result ?? res) as Record<string, unknown>;
  const id = result?.key ?? result?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}
