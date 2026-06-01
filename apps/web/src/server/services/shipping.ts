import 'server-only';

import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';
import { EasyPostApiError, EasyPostClient } from '@/server/connectors/easypost/client';
import { getConnectionSecret } from '@/server/connectors/secret-store';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

/**
 * Parcel dimensions the manager enters in the Buy-label dialog. Weight is in
 * ounces, lengths in inches — the units the EasyPost Parcel object expects
 * (`weight` in oz; `length`/`width`/`height` in inches).
 */
export const parcelSchema = z.object({
  weight_oz: z.number().positive(),
  length_in: z.number().positive(),
  width_in: z.number().positive(),
  height_in: z.number().positive(),
});
export type ParcelInput = z.infer<typeof parcelSchema>;

/** A single shoppable rate, flattened from the EasyPost Shipment `rates[]`. */
export interface ShippingRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days: number | null;
}

export interface GetRatesResult {
  /** Our `carrier_shipments.id` (the draft row). */
  shipmentId: string;
  /** EasyPost's Shipment id (used by `buyLabel`). */
  easypostShipmentId: string;
  rates: ShippingRate[];
}

/** A `carrier_shipments` row as the service hands it back. */
export interface CarrierShipmentRow {
  id: string;
  organization_id: string;
  order_request_id: string;
  connection_id: string | null;
  carrier: string | null;
  service: string | null;
  rate_cents: number | null;
  currency: string | null;
  tracking_code: string | null;
  tracking_status: string | null;
  tracking_url: string | null;
  label_url: string | null;
  easypost_shipment_id: string | null;
  easypost_rate_id: string | null;
  from_address: Record<string, unknown> | null;
  to_address: Record<string, unknown> | null;
  parcel: Record<string, unknown> | null;
  /**
   * 'outbound' = the forward delivery label (warehouse → charter); 'return' =
   * a reverse RMA label (charter → warehouse, EasyPost is_return:true). The 0156
   * per-direction partial unique index lets one active outbound AND one active
   * return label coexist per order. Legacy rows default to 'outbound'.
   */
  direction: 'outbound' | 'return';
  status:
    | 'draft'
    | 'purchasing'
    | 'purchased'
    | 'in_transit'
    | 'delivered'
    | 'returned'
    | 'failure'
    | 'cancelled';
  purchased_at: string | null;
  purchased_by: string | null;
}

/**
 * Structured address shape shared by `charters.address` and
 * `warehouses.address` (both jsonb, both mirror `WarehouseAddress`). The
 * service maps this onto the EasyPost Address shape.
 */
interface StoredAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  /** Some legacy warehouse rows use `state` instead of `region`. */
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/**
 * Maps our stored address jsonb onto the EasyPost Address shape. EasyPost wants
 * `street1`/`street2`/`city`/`state`/`zip`/`country`. We accept either `region`
 * (the canonical charter/warehouse field) or a legacy `state` key and default
 * the country to `US`.
 */
function toEasyPostAddress(addr: StoredAddress): Record<string, string> {
  const out: Record<string, string> = {};
  if (addr.line1) out.street1 = addr.line1;
  if (addr.line2) out.street2 = addr.line2;
  if (addr.city) out.city = addr.city;
  const state = addr.region ?? addr.state;
  if (state) out.state = state;
  if (addr.postalCode) out.zip = addr.postalCode;
  out.country = addr.country ?? 'US';
  return out;
}

/** True when an address carries at least a street line and city/zip. */
function hasMailingAddress(addr: StoredAddress | null | undefined): addr is StoredAddress {
  if (!addr) return false;
  return Boolean(addr.line1 && (addr.postalCode || addr.city));
}

/**
 * Carrier shipping (EasyPost) control surface. ONE-WAY by design: we PUSH label
 * requests (rate-shop + buy) and later RECEIVE tracking via the webhook — we
 * never mutate StockPilot inventory from EasyPost and never pull EasyPost data
 * back into stock.
 *
 * SECRET INVARIANT: the EasyPost API key lives ONLY in Vault. It is read via the
 * service-role admin client + `connector_secret_get`, handed straight to
 * `EasyPostClient`, and never returned to a client, written to a row, or logged.
 *
 * Gating: mutations (getRates buys nothing but creates a billable Shipment
 * object, buyLabel buys real postage) require `shipping` enabled +
 * `shipping:manage`. Reads (getShipment) are member-level + module-gated.
 *
 * Writes to `carrier_shipments` go through the SERVICE-ROLE admin client: the
 * permission gate already proves the caller is an authorized owner/admin (see
 * AUTHORIZATION below), and using the admin client keeps the write off the
 * user's RLS path so a local row is always recorded alongside the billable
 * EasyPost object (avoiding an orphaned EasyPost Shipment with no local row —
 * `getRates` inserts the local draft row BEFORE creating the EasyPost Shipment
 * for exactly this reason).
 *
 * AUTHORIZATION: every mutation gates on `assertPermission(ctx,'shipping:manage')`,
 * which `ROLE_PERMISSIONS` grants to OWNER + ADMIN only (mirrors
 * `integrations:manage`); a manager does NOT have it and is correctly blocked.
 * Because all `carrier_shipments` writes use the service-role admin client (RLS
 * bypassed), this app-layer permission gate — NOT the table's RLS write policy
 * — is the effective control. The 0149 RLS write policy (`has_org_role(...,
 * 'manager')`) is a more-permissive backstop for any future user-RLS writer and
 * is intentionally never the binding check here.
 *
 * DOUBLE-BUY SAFETY: `buyLabel` is airtight against concurrent/retried calls —
 * EasyPost can be charged AT MOST ONCE per order even under a multi-draft race
 * (two getRates sessions → two distinct 'draft' rows → two buyLabel calls
 * claiming DIFFERENT drafts). The guarantee is anchored at the DATABASE by the
 * 0150 partial unique index `carrier_shipments_one_active_per_order` on
 * (organization_id, order_request_id) WHERE status in ('purchasing','purchased'):
 * at most one row per order can occupy the active-buy slot.
 *
 *   1. Idempotent short-circuit: a 'purchased' row for the order → return it.
 *   2. RESOLVE the EasyPost key/addresses BEFORE claiming. Resolving first means
 *      a resolve failure (connection disconnected/flipped inactive, charter
 *      address removed, Vault/RPC error between getRates and buyLabel) throws
 *      while the row is still 'draft' — it can NEVER strand a row in
 *      'purchasing'. We only claim a slot we can actually use.
 *   3. CLAIM: atomically transition the chosen draft 'draft'→'purchasing'
 *      (UPDATE ... WHERE id=? AND status='draft'). The 0150 unique index makes a
 *      SECOND claim for the same order — whether the rival is already
 *      'purchasing' or 'purchased', possibly on a DIFFERENT draft row — raise a
 *      unique violation (SQLSTATE 23505). The service detects 23505 (and a
 *      zero-row claim) and resolves idempotently instead of 500ing or buying.
 *   4. Only the claim winner calls `client.buyShipment`, passing the row id as
 *      an EasyPost `Idempotency-Key` so a retried buy on the SAME shipment
 *      (after a timeout/5xx where EasyPost may already have charged) replays the
 *      original response instead of double-charging.
 *   5. SUCCESS → finalize the claimed row to 'purchased'.
 *   6. EasyPost FAILURE → branch on whether a charge could have occurred:
 *        • Definitive client error (4xx other than 429) PROVES no charge → roll
 *          the claimed row back to 'draft' (clear purchased_by) so it can be
 *          retried.
 *        • Ambiguous failure (timeout, network error, 5xx, 429) MIGHT have
 *          charged → RECONCILE via a GET of the shipment. If it now carries a
 *          postage_label, finalize to 'purchased' (the buy actually completed);
 *          if it definitively has none, roll back to 'draft'. If even the
 *          reconcile GET fails, LEAVE the row 'purchasing' (never blindly reopen
 *          a possibly-charged buy for re-buy) and surface a clear error pointing
 *          at the operator recovery runbook below.
 *
 * Because the 'purchasing' claim occupies the unique slot BEFORE the billable
 * call, two concurrent buyLabel calls can never both reach EasyPost, and a retry
 * after a successful buy short-circuits on the 'purchased' row.
 *
 * STUCK-ROW RECOVERY (operator runbook): a process crash / serverless timeout /
 * OOM between the claim (→'purchasing') and the finalize (→'purchased') can leave
 * a row stranded in 'purchasing'. The 0150 partial unique index then blocks every
 * future buyLabel for that order (the claim 23505s; resolveLostClaim finds no
 * 'purchased' row and throws "already in progress"), and getShipment hides it. To
 * recover such a row, an operator (or a future reaper) reconciles it against
 * EasyPost using its easypost_shipment_id:
 *   • GET the EasyPost shipment. If it carries a postage_label, the buy
 *     completed and was charged → finalize the row to 'purchased' (copy
 *     label_url / tracking_code / selected_rate as buyLabel's success path does).
 *   • If it has no postage_label, the buy never completed → reset the row to
 *     'draft' (clear purchased_by) so the order can be re-bought.
 * `reconcilePurchasing(orderRequestId)` performs exactly this against the latest
 * 'purchasing' row and is the programmatic entry point for that recovery.
 */
export class ShippingService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ShippingService(await withContext());
  }

  /** Build from a ServiceContext resolved by `withApiContext` in an API route. */
  static forApiContext(ctx: ServiceContext) {
    return new ShippingService(ctx);
  }

  private get admin() {
    return createAdminClient();
  }

  /**
   * Loads a delivery order_request and asserts it is shippable: must be a
   * `delivery` order with a `delivery_charter_id` whose charter has a mailing
   * address, and a warehouse origin with an address. Returns the resolved
   * from/to addresses + the active EasyPost connection + Vault key.
   */
  private async resolveShippingContext(orderRequestId: string) {
    const { data: order, error: orderError } = await this.ctx.supabase
      .from('order_requests')
      .select('id, organization_id, fulfillment_type, delivery_charter_id, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', orderRequestId)
      .maybeSingle();
    if (orderError) throw new ServiceError('internal_error', orderError.message);
    if (!order) throw new ServiceError('not_found', 'Order not found.');

    const o = order as {
      id: string;
      fulfillment_type: 'pickup' | 'delivery' | null;
      delivery_charter_id: string | null;
      warehouse_id: string | null;
    };

    if (o.fulfillment_type !== 'delivery' || !o.delivery_charter_id) {
      throw new ServiceError(
        'validation_error',
        'Shipping labels are only available for delivery orders with a destination charter.',
      );
    }
    if (!o.warehouse_id) {
      throw new ServiceError('validation_error', 'This order has no origin warehouse.');
    }

    // Destination = charter mailing address.
    const { data: charter, error: charterError } = await this.ctx.supabase
      .from('charters')
      .select('id, name, address')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', o.delivery_charter_id)
      .maybeSingle();
    if (charterError) throw new ServiceError('internal_error', charterError.message);
    const charterAddress = (charter as { address?: StoredAddress | null } | null)?.address ?? null;
    if (!hasMailingAddress(charterAddress)) {
      throw new ServiceError('validation_error', 'Destination charter has no mailing address');
    }

    // Origin = warehouse address.
    const { data: warehouse, error: warehouseError } = await this.ctx.supabase
      .from('warehouses')
      .select('id, name, address')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', o.warehouse_id)
      .maybeSingle();
    if (warehouseError) throw new ServiceError('internal_error', warehouseError.message);
    const warehouseAddress =
      (warehouse as { address?: StoredAddress | null } | null)?.address ?? null;
    if (!hasMailingAddress(warehouseAddress)) {
      throw new ServiceError('validation_error', 'Origin warehouse has no mailing address.');
    }

    // Active EasyPost connection + Vault key.
    const { data: conn, error: connError } = await this.ctx.supabase
      .from('org_connections')
      .select('id, provider_id, status, secret_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'easypost')
      .eq('status', 'active')
      .maybeSingle();
    if (connError) throw new ServiceError('internal_error', connError.message);
    const connection = conn as { id: string; secret_id: string | null } | null;
    if (!connection || !connection.secret_id) {
      throw new ServiceError(
        'validation_error',
        'No active EasyPost connection. Connect EasyPost in Integrations settings first.',
      );
    }

    const secrets = await getConnectionSecret(this.admin as never, connection.secret_id);
    const apiKey = typeof secrets.apiKey === 'string' ? secrets.apiKey : null;
    if (!apiKey) {
      throw new ServiceError('internal_error', 'EasyPost connection is missing its API key.');
    }

    return {
      orderRequestId: o.id,
      connectionId: connection.id,
      apiKey,
      fromAddress: toEasyPostAddress(warehouseAddress),
      toAddress: toEasyPostAddress(charterAddress),
    };
  }

  /**
   * Rate-shop: creates an EasyPost Shipment from the order's warehouse origin +
   * charter destination, persists a `draft` carrier_shipments row, and returns
   * the available rates. Creating a Shipment does NOT buy postage — `buyLabel`
   * does, on explicit rate confirmation.
   *
   * ORDERING: the local draft row is inserted BEFORE the EasyPost Shipment is
   * created (then patched with the EasyPost id), so a failure of the EasyPost
   * call leaves a recoverable local row rather than an orphaned billable-less
   * EasyPost object — matching the class doc's "no orphaned EasyPost object
   * without a local row" rationale for using the admin client.
   */
  async getRates(orderRequestId: string, parcel: ParcelInput): Promise<GetRatesResult> {
    assertModuleEnabled(this.ctx, 'shipping');
    assertPermission(this.ctx, 'shipping:manage');

    const parsed = parcelSchema.parse(parcel);
    const resolved = await this.resolveShippingContext(orderRequestId);

    const easypostParcel = {
      weight: parsed.weight_oz,
      length: parsed.length_in,
      width: parsed.width_in,
      height: parsed.height_in,
    };

    // Persist the draft row FIRST (service-role admin client — see class doc),
    // capturing the resolved addresses + parcel. The EasyPost shipment id is
    // patched in once the (non-billable) createShipment call returns; doing the
    // insert first guarantees the EasyPost Shipment is never orphaned without a
    // local row to find it from.
    const { data: inserted, error: insertError } = await this.admin
      .from('carrier_shipments')
      .insert({
        organization_id: this.ctx.organizationId,
        order_request_id: resolved.orderRequestId,
        connection_id: resolved.connectionId,
        status: 'draft',
        direction: 'outbound',
        from_address: resolved.fromAddress,
        to_address: resolved.toAddress,
        parcel: easypostParcel,
      })
      .select('id')
      .single();
    if (insertError) throw new ServiceError('internal_error', insertError.message);

    const shipmentId = (inserted as { id: string }).id;

    const client = new EasyPostClient(resolved.apiKey);
    const shipment = await client.createShipment({
      shipment: {
        to_address: resolved.toAddress,
        from_address: resolved.fromAddress,
        parcel: easypostParcel,
      },
    });

    const easypostShipmentId = String(shipment.id ?? '');
    const rawRates = Array.isArray(shipment.rates)
      ? (shipment.rates as Array<Record<string, unknown>>)
      : [];
    const rates: ShippingRate[] = rawRates.map((r) => ({
      id: String(r.id ?? ''),
      carrier: String(r.carrier ?? ''),
      service: String(r.service ?? ''),
      rate: String(r.rate ?? ''),
      currency: String(r.currency ?? 'USD'),
      delivery_days:
        r.delivery_days === null || r.delivery_days === undefined
          ? null
          : Number(r.delivery_days),
    }));

    // Patch the draft with the EasyPost shipment id so buyLabel (and the
    // webhook) can find this row.
    const { error: patchError } = await this.admin
      .from('carrier_shipments')
      .update({ easypost_shipment_id: easypostShipmentId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', shipmentId);
    if (patchError) throw new ServiceError('internal_error', patchError.message);

    void audit(
      {
        event: 'shipping.rates_fetched',
        entityType: 'carrier_shipment',
        entityId: shipmentId,
        extra: { orderRequestId: resolved.orderRequestId, rateCount: rates.length },
      },
      this.ctx,
    );

    return { shipmentId, easypostShipmentId, rates };
  }

  /**
   * Buys the selected rate, generating a postage label. AIRTIGHT against
   * concurrent/retried calls — EasyPost is charged AT MOST ONCE per order, even
   * under a multi-draft race (see the class-level DOUBLE-BUY SAFETY note). The
   * guarantee is anchored by the 0150 partial unique index
   * `carrier_shipments_one_active_per_order` (at most one 'purchasing'/'purchased'
   * row per order):
   *
   *   1. Short-circuit if a 'purchased' row already exists for the order.
   *   2. Load the most-recent draft.
   *   3. RESOLVE the EasyPost key/addresses BEFORE claiming, so a resolve failure
   *      throws while the row is still 'draft' (never stranding 'purchasing').
   *   4. CLAIM: atomically transition the draft 'draft'→'purchasing'. A SECOND
   *      claim for the same order (rival already 'purchasing'/'purchased', even
   *      on a different draft row) violates the unique index → SQLSTATE 23505,
   *      which we catch; a zero-row claim means the predicate already moved on.
   *      Either way we re-check for a 'purchased' row and return it, else throw
   *      a clear "in progress" ServiceError — never reaching EasyPost twice.
   *   5. Only the claim winner calls EasyPost `buyShipment`, keyed with the row
   *      id as an Idempotency-Key (a retried buy can't double-charge).
   *   6. SUCCESS → finalize the claimed row to 'purchased'.
   *   7. EasyPost FAILURE → roll back to 'draft' ONLY on a definitive no-charge
   *      4xx; on an ambiguous failure (timeout/5xx/429) reconcile via a GET and
   *      finalize-or-rollback, leaving the row 'purchasing' if even the GET
   *      fails (so a possibly-charged buy is never blindly re-bought).
   */
  async buyLabel(orderRequestId: string, rateId: string): Promise<CarrierShipmentRow> {
    assertModuleEnabled(this.ctx, 'shipping');
    assertPermission(this.ctx, 'shipping:manage');

    // Idempotency guard FIRST: a purchased OUTBOUND row blocks a re-buy. Read via
    // the admin client so the check sees rows regardless of the user's RLS path.
    // Scoped to direction='outbound' so a return label (0156) on the same order
    // is never mistaken for the forward label.
    const purchased = await this.findPurchased(orderRequestId, 'outbound');
    if (purchased) return purchased;

    // Load the most-recent OUTBOUND draft for this order.
    const { data: draft, error: draftError } = await this.admin
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      .eq('direction', 'outbound')
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (draftError) throw new ServiceError('internal_error', draftError.message);
    const draftRow = draft as CarrierShipmentRow | null;
    if (!draftRow || !draftRow.easypost_shipment_id) {
      throw new ServiceError(
        'validation_error',
        'No draft shipment to buy. Fetch rates first.',
      );
    }

    // RESOLVE the EasyPost key BEFORE claiming. resolveShippingContext does
    // several DB reads + a Vault secret fetch, all of which can throw (connection
    // disconnected or flipped inactive between getRates and buyLabel, charter
    // address removed, Vault/RPC transient error). Doing it BEFORE the claim
    // guarantees such a throw leaves the row 'draft' — it can never strand the
    // order in 'purchasing' (which the 0150 unique index would treat as an
    // occupied slot, permanently wedging every future buyLabel). We only claim a
    // slot we can actually use.
    const resolved = await this.resolveShippingContext(orderRequestId);
    const client = new EasyPostClient(resolved.apiKey);

    // CLAIM: transition the chosen draft 'draft'→'purchasing' BEFORE any billable
    // EasyPost call. The 0150 partial unique index on (organization_id,
    // order_request_id) WHERE status in ('purchasing','purchased') makes this the
    // airtight gate: a SECOND claim for the same order — whether a rival already
    // sits in 'purchasing'/'purchased' on this OR a different draft row — raises a
    // unique violation (SQLSTATE 23505). We detect that error code (and a zero-row
    // claim, where the row was no longer 'draft') and resolve idempotently rather
    // than letting it 500 or reaching EasyPost a second time.
    const {
      data: claimed,
      error: claimError,
    } = await this.admin
      .from('carrier_shipments')
      .update({ status: 'purchasing', purchased_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftRow.id)
      .eq('status', 'draft')
      .select('id');

    if (claimError) {
      // 23505 = unique_violation on carrier_shipments_one_active_per_order:
      // another claim already occupies this order's active-buy slot. Treat as a
      // lost race, NOT a 500.
      if (claimError.code === '23505') {
        return await this.resolveLostClaim(orderRequestId, 'outbound');
      }
      throw new ServiceError('internal_error', claimError.message);
    }
    const claimedRows = (claimed as Array<{ id: string }> | null) ?? [];
    if (claimedRows.length === 0) {
      // Zero rows updated: the row was no longer 'draft' (a concurrent/prior buy
      // already claimed it). Resolve idempotently.
      return await this.resolveLostClaim(orderRequestId, 'outbound');
    }

    // We OWN the 'purchasing' claim. Buy the label, passing the row id as an
    // EasyPost Idempotency-Key: a retried buy on the SAME shipment (after a
    // timeout/5xx where EasyPost may already have charged) replays the original
    // response instead of buying twice.
    let bought: Record<string, unknown>;
    try {
      bought = await client.buyShipment(
        draftRow.easypost_shipment_id,
        rateId,
        draftRow.id,
      );
    } catch (err) {
      return await this.handleBuyFailure(orderRequestId, draftRow, client, err);
    }

    const updated = await this.finalizePurchased(draftRow, bought, rateId);

    void audit(
      {
        event: 'shipping.label_purchased',
        entityType: 'carrier_shipment',
        entityId: draftRow.id,
        extra: { orderRequestId, carrier: updated.carrier, rateCents: updated.rate_cents },
      },
      this.ctx,
    );

    return updated;
  }

  /**
   * Build the 'purchased' updates from a bought/retrieved EasyPost Shipment and
   * finalize the claimed row as a compare-and-swap (only the row we still own in
   * 'purchasing' transitions to 'purchased'). Shared by the buy-success path and
   * the reconcile path so both write identical, complete label/tracking fields.
   */
  private async finalizePurchased(
    draftRow: CarrierShipmentRow,
    shipment: Record<string, unknown>,
    rateId: string,
  ): Promise<CarrierShipmentRow> {
    const selectedRate = (shipment.selected_rate as Record<string, unknown> | undefined) ?? {};
    const postageLabel = (shipment.postage_label as Record<string, unknown> | undefined) ?? {};
    const tracker = (shipment.tracker as Record<string, unknown> | undefined) ?? {};

    const rateStr = selectedRate.rate;
    const rateCents =
      rateStr === undefined || rateStr === null ? null : Math.round(Number(rateStr) * 100);

    const updates = {
      status: 'purchased' as const,
      label_url: (postageLabel.label_url as string | undefined) ?? null,
      tracking_code: (shipment.tracking_code as string | undefined) ?? null,
      tracking_url:
        (tracker.public_url as string | undefined) ??
        (shipment.tracking_url as string | undefined) ??
        null,
      carrier: (selectedRate.carrier as string | undefined) ?? null,
      service: (selectedRate.service as string | undefined) ?? null,
      rate_cents: rateCents,
      currency: (selectedRate.currency as string | undefined) ?? draftRow.currency ?? 'USD',
      // Prefer EasyPost's echoed selected_rate.id (the rate actually bought).
      // Fall back to the caller-supplied rateId only if EasyPost omitted it;
      // EasyPost validates rateId against the shipment, so a mismatched id is
      // rejected before this point and never persisted.
      easypost_rate_id: (selectedRate.id as string | undefined) ?? rateId,
      purchased_at: new Date().toISOString(),
      purchased_by: this.ctx.userId,
    };

    // Finalize as a compare-and-swap on the row we claimed: only transition the
    // row we still own ('purchasing') to 'purchased'.
    const { data: updated, error: updateError } = await this.admin
      .from('carrier_shipments')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftRow.id)
      .eq('status', 'purchasing')
      .select('*')
      .single();
    if (updateError) throw new ServiceError('internal_error', updateError.message);
    return updated as CarrierShipmentRow;
  }

  /**
   * Reset a claimed 'purchasing' row back to 'draft' (clearing purchased_by) so
   * the order is not stuck and can be retried. Used when a buy failure PROVES no
   * charge occurred. Best-effort: a rollback failure surfaces a combined error
   * rather than masking the original cause.
   */
  private async rollbackClaim(draftRow: CarrierShipmentRow, original: unknown): Promise<never> {
    const { error: rollbackError } = await this.admin
      .from('carrier_shipments')
      .update({ status: 'draft', purchased_by: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftRow.id)
      .eq('status', 'purchasing');
    if (rollbackError) {
      throw new ServiceError(
        'internal_error',
        `Label purchase failed and the shipment could not be reset (${rollbackError.message}). Original error: ${
          original instanceof Error ? original.message : String(original)
        }`,
      );
    }
    throw new ServiceError(
      'validation_error',
      `Label purchase failed at the carrier: ${
        original instanceof Error ? original.message : String(original)
      }`,
    );
  }

  /**
   * Decide what to do after `client.buyShipment` threw, WITHOUT risking a double
   * charge:
   *   • Definitive client error (EasyPostApiError 4xx, excluding 429) PROVES the
   *     buy never charged → roll the claim back to 'draft' for retry.
   *   • Ambiguous failure (timeout, network error, 5xx, 429) MIGHT have charged
   *     → RECONCILE via a GET of the shipment. If it now carries a postage_label,
   *     the buy actually completed → finalize to 'purchased'. If it definitively
   *     has none, roll back to 'draft'. If the GET itself fails, LEAVE the row
   *     'purchasing' (never blindly reopen a possibly-charged buy) and surface a
   *     clear error pointing at the recovery runbook (reconcilePurchasing).
   */
  private async handleBuyFailure(
    orderRequestId: string,
    draftRow: CarrierShipmentRow,
    client: EasyPostClient,
    err: unknown,
  ): Promise<CarrierShipmentRow> {
    const definitiveNoCharge =
      err instanceof EasyPostApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
    if (definitiveNoCharge) {
      // 4xx (not 429): EasyPost rejected the request before charging. Safe to
      // reopen the draft for a corrected retry.
      return await this.rollbackClaim(draftRow, err);
    }

    // Ambiguous: the buy may have completed server-side. Reconcile via GET.
    const shipmentId = draftRow.easypost_shipment_id;
    if (!shipmentId) {
      // No id to reconcile against (should not happen — buyLabel guards it) →
      // treat conservatively as no-charge and reopen.
      return await this.rollbackClaim(draftRow, err);
    }
    let reconciled: Record<string, unknown>;
    try {
      reconciled = await client.retrieveShipment(shipmentId);
    } catch {
      // Even the reconcile GET failed. Do NOT roll back — leave the row
      // 'purchasing' so a possibly-charged buy is never re-bought. Recovery is
      // via reconcilePurchasing (see the class-level runbook).
      throw new ServiceError(
        'internal_error',
        'Label purchase could not be confirmed at the carrier and the shipment status could not be reconciled. ' +
          'The order is left mid-purchase; run shipment reconciliation to resolve it. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const postageLabel =
      (reconciled.postage_label as Record<string, unknown> | undefined) ?? undefined;
    if (postageLabel && postageLabel.label_url) {
      // The buy DID complete (and was charged). Finalize from the reconciled
      // shipment so the paid label is reflected instead of being lost.
      const selectedRate = (reconciled.selected_rate as Record<string, unknown> | undefined) ?? {};
      const rateId = (selectedRate.id as string | undefined) ?? '';
      const updated = await this.finalizePurchased(draftRow, reconciled, rateId);
      void audit(
        {
          event: 'shipping.label_purchased',
          entityType: 'carrier_shipment',
          entityId: draftRow.id,
          extra: {
            orderRequestId,
            carrier: updated.carrier,
            rateCents: updated.rate_cents,
            reconciled: true,
          },
        },
        this.ctx,
      );
      return updated;
    }

    // Reconcile confirms NO label was bought → safe to reopen the draft.
    return await this.rollbackClaim(draftRow, err);
  }

  /**
   * Operator/reaper recovery for a row stranded in 'purchasing' (process crash /
   * serverless timeout between claim and finalize — see the class-level runbook).
   * Reconciles the latest 'purchasing' row for the order against EasyPost:
   *   • postage_label present → finalize to 'purchased' (the buy was charged).
   *   • no postage_label → reset to 'draft' so the order can be re-bought.
   * Idempotent: if no 'purchasing' row exists it returns the 'purchased' row (if
   * any) or null. Gated like every mutation (shipping + shipping:manage).
   */
  async reconcilePurchasing(orderRequestId: string): Promise<CarrierShipmentRow | null> {
    assertModuleEnabled(this.ctx, 'shipping');
    assertPermission(this.ctx, 'shipping:manage');

    const { data: stuck, error: stuckError } = await this.admin
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      .eq('direction', 'outbound')
      .eq('status', 'purchasing')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (stuckError) throw new ServiceError('internal_error', stuckError.message);
    const stuckRow = stuck as CarrierShipmentRow | null;
    if (!stuckRow) {
      // Nothing stranded — return the purchased OUTBOUND row if the buy completed.
      return await this.findPurchased(orderRequestId, 'outbound');
    }
    if (!stuckRow.easypost_shipment_id) {
      // No EasyPost id to reconcile against → it never reached the carrier; reopen.
      const { error: resetError } = await this.admin
        .from('carrier_shipments')
        .update({ status: 'draft', purchased_by: null })
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', stuckRow.id)
        .eq('status', 'purchasing');
      if (resetError) throw new ServiceError('internal_error', resetError.message);
      return null;
    }

    const resolved = await this.resolveShippingContext(orderRequestId);
    const client = new EasyPostClient(resolved.apiKey);
    const shipment = await client.retrieveShipment(stuckRow.easypost_shipment_id);

    const postageLabel = (shipment.postage_label as Record<string, unknown> | undefined) ?? undefined;
    if (postageLabel && postageLabel.label_url) {
      const selectedRate = (shipment.selected_rate as Record<string, unknown> | undefined) ?? {};
      const rateId = (selectedRate.id as string | undefined) ?? '';
      const updated = await this.finalizePurchased(stuckRow, shipment, rateId);
      void audit(
        {
          event: 'shipping.label_purchased',
          entityType: 'carrier_shipment',
          entityId: stuckRow.id,
          extra: { orderRequestId, reconciled: true },
        },
        this.ctx,
      );
      return updated;
    }

    // No label at the carrier → reset to draft for a clean re-buy.
    const { error: resetError } = await this.admin
      .from('carrier_shipments')
      .update({ status: 'draft', purchased_by: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', stuckRow.id)
      .eq('status', 'purchasing');
    if (resetError) throw new ServiceError('internal_error', resetError.message);
    return null;
  }

  /**
   * SERVICE-ROLE reaper recovery for a single row stranded in 'purchasing'.
   * Runs WITHOUT a ServiceContext — driven by the reap-stuck-shipments cron,
   * which has no user session — so it takes the service-role admin client and
   * the stuck `carrier_shipments` row directly. It resolves the row's org's
   * active EasyPost connection + Vault key, GETs the EasyPost shipment, and:
   *   • postage_label present → finalize to 'purchased' (the buy was charged).
   *   • no postage_label → reset to 'draft' so the order can be re-bought.
   * Returns the new status the row was moved to ('purchased' | 'draft'), or
   * 'skipped' when the row can't be reconciled (no easypost id, or the org has
   * no active EasyPost connection / key — left 'purchasing' for an operator).
   *
   * SAFETY: like reconcilePurchasing, this NEVER re-buys — it only reads the
   * EasyPost shipment and copies the already-charged label, or reopens a row
   * that definitively never got one. All transitions are compare-and-swaps
   * scoped to the row's own id+org WHERE status='purchasing', so a concurrent
   * operator/buy that already moved the row makes the reaper a no-op.
   */
  static async reapStuckShipment(
    admin: ReturnType<typeof createAdminClient>,
    row: CarrierShipmentRow,
  ): Promise<'purchased' | 'draft' | 'skipped'> {
    // Resolve the org's active EasyPost connection + Vault key directly (no
    // ServiceContext). Mirrors the connection/key half of resolveShippingContext
    // but scoped by the row's organization_id via the service-role client.
    const { data: conn, error: connError } = await admin
      .from('org_connections')
      .select('id, secret_id')
      .eq('organization_id', row.organization_id)
      .eq('provider_id', 'easypost')
      .eq('status', 'active')
      .maybeSingle();
    if (connError) throw new ServiceError('internal_error', connError.message);
    const connection = conn as { id: string; secret_id: string | null } | null;

    // No EasyPost id, or no active connection/key to reconcile against. We can't
    // safely confirm whether the carrier charged, so DO NOT reset to 'draft'
    // (that could re-buy an already-charged label). Leave the row 'purchasing'
    // for an operator to resolve.
    if (!row.easypost_shipment_id || !connection || !connection.secret_id) {
      return 'skipped';
    }

    const secrets = await getConnectionSecret(admin as never, connection.secret_id);
    const apiKey = typeof secrets.apiKey === 'string' ? secrets.apiKey : null;
    if (!apiKey) return 'skipped';

    const client = new EasyPostClient(apiKey);
    const shipment = await client.retrieveShipment(row.easypost_shipment_id);

    const postageLabel =
      (shipment.postage_label as Record<string, unknown> | undefined) ?? undefined;
    if (postageLabel && postageLabel.label_url) {
      const selectedRate = (shipment.selected_rate as Record<string, unknown> | undefined) ?? {};
      const rateStr = selectedRate.rate;
      const rateCents =
        rateStr === undefined || rateStr === null ? null : Math.round(Number(rateStr) * 100);
      const tracker = (shipment.tracker as Record<string, unknown> | undefined) ?? {};
      const { error: finalizeError } = await admin
        .from('carrier_shipments')
        .update({
          status: 'purchased' as const,
          label_url: (postageLabel.label_url as string | undefined) ?? null,
          tracking_code: (shipment.tracking_code as string | undefined) ?? null,
          tracking_url:
            (tracker.public_url as string | undefined) ??
            (shipment.tracking_url as string | undefined) ??
            null,
          carrier: (selectedRate.carrier as string | undefined) ?? null,
          service: (selectedRate.service as string | undefined) ?? null,
          rate_cents: rateCents,
          currency: (selectedRate.currency as string | undefined) ?? row.currency ?? 'USD',
          easypost_rate_id: (selectedRate.id as string | undefined) ?? row.easypost_rate_id ?? null,
          purchased_at: new Date().toISOString(),
        })
        .eq('organization_id', row.organization_id)
        .eq('id', row.id)
        .eq('status', 'purchasing');
      if (finalizeError) throw new ServiceError('internal_error', finalizeError.message);
      return 'purchased';
    }

    // No label at the carrier → the buy never completed; reopen for a clean re-buy.
    const { error: resetError } = await admin
      .from('carrier_shipments')
      .update({ status: 'draft', purchased_by: null })
      .eq('organization_id', row.organization_id)
      .eq('id', row.id)
      .eq('status', 'purchasing');
    if (resetError) throw new ServiceError('internal_error', resetError.message);
    return 'draft';
  }

  /**
   * Read the single 'purchased' row for an order via the admin client, or null.
   * Scoped to a single `direction` ('outbound' delivery label vs 'return' RMA
   * label) so the per-direction unique slot (0156) is honored: an outbound buy's
   * idempotency guard never short-circuits on a return label and vice-versa.
   */
  private async findPurchased(
    orderRequestId: string,
    direction: 'outbound' | 'return',
  ): Promise<CarrierShipmentRow | null> {
    const { data, error } = await this.admin
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      .eq('direction', direction)
      .eq('status', 'purchased')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as CarrierShipmentRow | null) ?? null;
  }

  /**
   * Resolve a lost claim (zero-row claim OR 23505 unique violation): a
   * concurrent/prior buy won the order's active-buy slot for this `direction`.
   * Return its 'purchased' row if it has completed, otherwise throw a clear
   * retryable error — never reaching EasyPost.
   */
  private async resolveLostClaim(
    orderRequestId: string,
    direction: 'outbound' | 'return',
  ): Promise<CarrierShipmentRow> {
    const winner = await this.findPurchased(orderRequestId, direction);
    if (winner) return winner;
    throw new ServiceError(
      'validation_error',
      'A label purchase is already in progress for this order',
    );
  }

  /**
   * Member-level read of the shipment for an order. Returns the single
   * most-recent row whose status is NOT IN ('draft','purchasing') by
   * `created_at` — i.e. the latest actually purchased/active shipment (status in
   * purchased/in_transit/delivered/returned/failure/cancelled) — or null when
   * only draft/in-flight row(s) exist (or nothing at all). Reads ride the user's
   * RLS (member-read policy on carrier_shipments).
   *
   * Both 'draft' AND 'purchasing' rows are intentionally excluded: a draft is
   * created during `getRates` before any label is bought, and a 'purchasing' row
   * is a mid-buy claim (0150) that has not yet completed at EasyPost — surfacing
   * either would make the web order page and the mobile order screen show a
   * phantom/half-bought "shipment". These rows still live in the table for the
   * in-flight buy flow (`buyLabel` claims the latest draft into 'purchasing')
   * — they are just not surfaced as "the shipment". The buy-label dialog uses
   * the rates/label endpoints, not `getShipment`, so it is unaffected.
   */
  async getShipment(orderRequestId: string): Promise<CarrierShipmentRow | null> {
    assertModuleEnabled(this.ctx, 'shipping');

    const { data, error } = await this.ctx.supabase
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      // The order page's Shipping panel surfaces the FORWARD delivery label;
      // scope to direction='outbound' so a return label (0156) is never shown
      // here as "the shipment". Return labels surface on the return detail page.
      .eq('direction', 'outbound')
      .in('status', ['purchased', 'in_transit', 'delivered', 'returned', 'failure', 'cancelled'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as CarrierShipmentRow | null) ?? null;
  }

  /**
   * Member-level read of the RETURN (reverse) label for a return. Resolves the
   * return's order_request_id, then returns the latest active direction='return'
   * row (status NOT IN draft/purchasing) — the purchased return label + its
   * tracking — or null when none exists yet. Drives the return detail page's
   * "Return label" section. Reads ride the user's RLS.
   */
  async getReturnLabel(returnId: string): Promise<CarrierShipmentRow | null> {
    assertModuleEnabled(this.ctx, 'shipping');

    const { data: ret, error: retError } = await this.ctx.supabase
      .from('returns')
      .select('order_request_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', returnId)
      .maybeSingle();
    if (retError) throw new ServiceError('internal_error', retError.message);
    if (!ret) return null;
    const orderRequestId = (ret as { order_request_id: string }).order_request_id;

    const { data, error } = await this.ctx.supabase
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      .eq('direction', 'return')
      .in('status', ['purchased', 'in_transit', 'delivered', 'returned', 'failure', 'cancelled'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as CarrierShipmentRow | null) ?? null;
  }

  /**
   * Buy a REVERSE (RMA) label for an approved/received return. Mirrors
   * `buyLabel`'s claim/idempotency design, but the return label differs in two
   * ways:
   *
   *   • REVERSED addresses + is_return:true — the parcel travels BACK from the
   *     charter (the destination of the forward delivery) to the warehouse
   *     origin, so the EasyPost shipment's to_address = warehouse, from_address =
   *     charter, with is_return:true. We resolve the SAME order context as the
   *     forward label and simply swap from/to.
   *
   *   • One-shot create+buy (no separate rate-shop). There is no return-rate
   *     dialog — we createShipment, then buy the cheapest returned rate.
   *
   * DOUBLE-BUY SAFETY is identical to `buyLabel` and anchored at the DATABASE by
   * the 0156 per-direction partial unique index (one active OUTBOUND and one
   * active RETURN per order can coexist, but never two of the same direction):
   *   1. Idempotent short-circuit on an existing direction='return' 'purchased'
   *      row for the order.
   *   2. RESOLVE the EasyPost key/addresses BEFORE inserting/claiming, so a
   *      resolve failure can never strand a row mid-buy.
   *   3. Insert a direction='return' draft, createShipment (non-billable), then
   *      CLAIM the draft 'draft'→'purchasing'. A second concurrent return-label
   *      claim raises 23505 on the per-direction unique index and is resolved
   *      idempotently (never a second EasyPost charge).
   *   4. Only the claim winner calls `buyShipment`, keyed with the row id as an
   *      Idempotency-Key.
   *   5. SUCCESS → finalize to 'purchased'. FAILURE → the SAME handleBuyFailure
   *      branch as the forward buy (definitive 4xx rolls back to 'draft';
   *      ambiguous failure reconciles via a GET; both compare-and-swap on the
   *      claimed row's own id, so they are direction-agnostic and safe).
   */
  async buyReturnLabel(returnId: string): Promise<CarrierShipmentRow> {
    assertModuleEnabled(this.ctx, 'shipping');
    assertPermission(this.ctx, 'shipping:manage');

    // 1. Load the return (org-scoped) and assert it is at a stage where a return
    //    label makes sense (approved or received). The return is the link to its
    //    order_request_id, which drives the reversed shipping context.
    const { data: ret, error: retError } = await this.ctx.supabase
      .from('returns')
      .select('id, organization_id, order_request_id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', returnId)
      .maybeSingle();
    if (retError) throw new ServiceError('internal_error', retError.message);
    if (!ret) throw new ServiceError('not_found', 'Return not found.');
    const returnRow = ret as {
      id: string;
      order_request_id: string;
      status: string;
    };
    if (returnRow.status !== 'approved' && returnRow.status !== 'received') {
      throw new ServiceError(
        'validation_error',
        'A return label can only be bought for an approved or received return.',
      );
    }

    const orderRequestId = returnRow.order_request_id;

    // 2. Idempotency guard FIRST: an existing direction='return' 'purchased' row
    //    blocks a re-buy. Independent of any forward (outbound) label.
    const existing = await this.findPurchased(orderRequestId, 'return');
    if (existing) return existing;

    // 3. RESOLVE the forward order context BEFORE inserting/claiming (so a
    //    resolve failure leaves nothing mid-buy), then REVERSE the addresses:
    //    the return travels charter → warehouse.
    const resolved = await this.resolveShippingContext(orderRequestId);
    const returnToAddress = resolved.fromAddress; // warehouse origin
    const returnFromAddress = resolved.toAddress; // charter destination
    const client = new EasyPostClient(resolved.apiKey);

    // Insert the direction='return' draft FIRST (service-role admin client — see
    // class doc), so the billable EasyPost Shipment is never orphaned without a
    // local row. The easypost_shipment_id is patched in after createShipment.
    const { data: inserted, error: insertError } = await this.admin
      .from('carrier_shipments')
      .insert({
        organization_id: this.ctx.organizationId,
        order_request_id: orderRequestId,
        connection_id: resolved.connectionId,
        status: 'draft',
        direction: 'return',
        from_address: returnFromAddress,
        to_address: returnToAddress,
      })
      .select('*')
      .single();
    if (insertError) throw new ServiceError('internal_error', insertError.message);
    const draftRow = inserted as CarrierShipmentRow;

    // createShipment with is_return:true + reversed addresses (non-billable).
    let shipment: Record<string, unknown>;
    try {
      shipment = await client.createShipment({
        shipment: {
          to_address: returnToAddress,
          from_address: returnFromAddress,
          is_return: true,
        },
      });
    } catch (err) {
      // The Shipment was never created → no charge possible. Reopen/close out the
      // draft so it does not occupy state, then surface the error.
      await this.discardReturnDraft(draftRow.id);
      throw new ServiceError(
        'validation_error',
        `Could not create the return shipment at the carrier: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const easypostShipmentId = String(shipment.id ?? '');
    const rates = Array.isArray(shipment.rates)
      ? (shipment.rates as Array<Record<string, unknown>>)
      : [];
    const cheapest = pickCheapestRate(rates);
    if (!easypostShipmentId || !cheapest) {
      await this.discardReturnDraft(draftRow.id);
      throw new ServiceError(
        'validation_error',
        'No return rates were available for this shipment.',
      );
    }

    // Patch the draft with the EasyPost shipment id BEFORE claiming so the
    // reconcile/recovery paths can find this row.
    const { error: patchError } = await this.admin
      .from('carrier_shipments')
      .update({ easypost_shipment_id: easypostShipmentId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftRow.id);
    if (patchError) throw new ServiceError('internal_error', patchError.message);
    const draftWithEasypost: CarrierShipmentRow = {
      ...draftRow,
      easypost_shipment_id: easypostShipmentId,
    };

    // CLAIM: 'draft'→'purchasing' BEFORE the billable buy. The 0156 per-direction
    // unique index makes a second concurrent return-label claim for this order
    // raise 23505, which resolveLostClaim handles idempotently.
    const { data: claimed, error: claimError } = await this.admin
      .from('carrier_shipments')
      .update({ status: 'purchasing', purchased_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftWithEasypost.id)
      .eq('status', 'draft')
      .select('id');
    if (claimError) {
      if (claimError.code === '23505') {
        return await this.resolveLostClaim(orderRequestId, 'return');
      }
      throw new ServiceError('internal_error', claimError.message);
    }
    const claimedRows = (claimed as Array<{ id: string }> | null) ?? [];
    if (claimedRows.length === 0) {
      return await this.resolveLostClaim(orderRequestId, 'return');
    }

    // We OWN the claim — buy the cheapest return rate, keyed with the row id.
    let bought: Record<string, unknown>;
    try {
      bought = await client.buyShipment(easypostShipmentId, cheapest.id, draftWithEasypost.id);
    } catch (err) {
      // SAME failure handling as the forward buy. handleBuyFailure compares-and-
      // swaps on the claimed row's own id, so it is direction-agnostic.
      return await this.handleBuyFailure(orderRequestId, draftWithEasypost, client, err);
    }

    const updated = await this.finalizePurchased(draftWithEasypost, bought, cheapest.id);

    void audit(
      {
        event: 'shipping.return_label_purchased',
        entityType: 'carrier_shipment',
        entityId: draftWithEasypost.id,
        extra: {
          returnId,
          orderRequestId,
          carrier: updated.carrier,
          rateCents: updated.rate_cents,
        },
      },
      this.ctx,
    );

    return updated;
  }

  /**
   * Best-effort cleanup of a just-inserted direction='return' draft that could
   * not progress (createShipment failed, or no rates). The row is still 'draft'
   * (it never reached 'purchasing'), so it occupies NO active slot and a failed
   * delete is non-fatal — we mark it 'cancelled' to keep it from lingering as a
   * stale draft. Never throws: the caller surfaces the real error.
   */
  private async discardReturnDraft(id: string): Promise<void> {
    await this.admin
      .from('carrier_shipments')
      .update({ status: 'cancelled' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', 'draft');
  }
}

/**
 * Pick the cheapest rate from an EasyPost Shipment `rates[]`, parsing the
 * decimal `rate` string. Returns the flattened rate (with its EasyPost id) or
 * null when there are no usable rates.
 */
function pickCheapestRate(
  rates: Array<Record<string, unknown>>,
): { id: string; rate: number } | null {
  let best: { id: string; rate: number } | null = null;
  for (const r of rates) {
    const id = typeof r.id === 'string' ? r.id : '';
    if (!id) continue;
    const rate = Number(r.rate);
    if (!Number.isFinite(rate)) continue;
    if (!best || rate < best.rate) best = { id, rate };
  }
  return best;
}
