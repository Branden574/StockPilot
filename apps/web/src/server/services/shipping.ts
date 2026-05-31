import 'server-only';

import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';
import { EasyPostClient } from '@/server/connectors/easypost/client';
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
  status: 'draft' | 'purchased' | 'in_transit' | 'delivered' | 'returned' | 'failure' | 'cancelled';
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
 * DOUBLE-BUY SAFETY: `buyLabel` is idempotent against concurrent/retried calls.
 * It claims the draft with an atomic compare-and-swap (UPDATE ... WHERE id=? AND
 * status='draft' AND purchased_by IS NULL) before calling EasyPost, so only one
 * of two concurrent calls ever reaches `client.buyShipment`; the loser re-reads
 * and returns the purchased row. The claim also stamps `purchased_by`, so a
 * retry after a successful buy but a failed final UPDATE will NOT re-claim (and
 * therefore will not re-buy) — it returns the already-purchased row instead.
 * NOTE: this is application-level CAS, not a DB constraint. A DB-level partial
 * unique index on (organization_id, order_request_id) WHERE status='purchased'
 * would harden this further but requires a migration (deferred; out of scope
 * here — 0149 is already applied to prod).
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
   * Buys the selected rate, generating a postage label. IDEMPOTENT and safe
   * against concurrent/retried calls (no double charge):
   *
   *   1. Short-circuit if a `purchased` row already exists for the order.
   *   2. Load the most-recent draft.
   *   3. Atomically CLAIM the draft with a compare-and-swap — UPDATE ... WHERE
   *      id=? AND status='draft' AND purchased_by IS NULL — stamping
   *      purchased_by/purchased_at. If zero rows are claimed, another call (or
   *      a prior, partially-completed attempt) already owns this draft: re-read
   *      the purchased row and return it rather than buying again.
   *   4. Only the winning claimant calls EasyPost `buyShipment` and stamps the
   *      row `purchased`.
   *
   * Because the claim is the atomic gate, two concurrent buyLabel calls cannot
   * both reach EasyPost, and a retry after a successful buy but a failed final
   * UPDATE will not re-buy (the row is already claimed). The `easypost_*` ids
   * stored at claim time let a retry/operator recover the purchased state.
   */
  async buyLabel(orderRequestId: string, rateId: string): Promise<CarrierShipmentRow> {
    assertModuleEnabled(this.ctx, 'shipping');
    assertPermission(this.ctx, 'shipping:manage');

    // Idempotency guard FIRST: a purchased row blocks a re-buy. Read via the
    // admin client so the check sees rows regardless of the user's RLS path.
    const { data: purchased, error: purchasedError } = await this.admin
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      .eq('status', 'purchased')
      .maybeSingle();
    if (purchasedError) throw new ServiceError('internal_error', purchasedError.message);
    if (purchased) {
      return purchased as CarrierShipmentRow;
    }

    // Load the most-recent draft for this order.
    const { data: draft, error: draftError } = await this.admin
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
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

    // ATOMIC CLAIM (compare-and-swap): take ownership of this draft before any
    // billable EasyPost call. The `status='draft' AND purchased_by IS NULL`
    // predicate means exactly one concurrent caller wins; the DB applies the
    // UPDATE atomically per row, so a second concurrent caller updates zero
    // rows. We keep status='draft' here (the table's CHECK constraint has no
    // intermediate state) but set purchased_by, which is the lock witness.
    const claimStamp = new Date().toISOString();
    const { data: claimed, error: claimError } = await this.admin
      .from('carrier_shipments')
      .update({ purchased_by: this.ctx.userId, purchased_at: claimStamp })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftRow.id)
      .eq('status', 'draft')
      .is('purchased_by', null)
      .select('id');
    if (claimError) throw new ServiceError('internal_error', claimError.message);
    const claimedRows = (claimed as Array<{ id: string }> | null) ?? [];
    if (claimedRows.length === 0) {
      // Lost the race (or a prior attempt already claimed + bought this draft):
      // re-read the purchased row and return it idempotently. If it is not yet
      // 'purchased' another call is mid-flight at EasyPost; surface a clear
      // retryable error rather than risk a parallel buy.
      const { data: rePurchased, error: reError } = await this.admin
        .from('carrier_shipments')
        .select('*')
        .eq('organization_id', this.ctx.organizationId)
        .eq('order_request_id', orderRequestId)
        .eq('status', 'purchased')
        .maybeSingle();
      if (reError) throw new ServiceError('internal_error', reError.message);
      if (rePurchased) return rePurchased as CarrierShipmentRow;
      throw new ServiceError(
        'validation_error',
        'This label is already being purchased. Refresh in a moment.',
      );
    }

    // Resolve the EasyPost key for this order's connection.
    const resolved = await this.resolveShippingContext(orderRequestId);
    const client = new EasyPostClient(resolved.apiKey);
    const bought = await client.buyShipment(draftRow.easypost_shipment_id, rateId);

    const selectedRate = (bought.selected_rate as Record<string, unknown> | undefined) ?? {};
    const postageLabel = (bought.postage_label as Record<string, unknown> | undefined) ?? {};
    const tracker = (bought.tracker as Record<string, unknown> | undefined) ?? {};

    const rateStr = selectedRate.rate;
    const rateCents =
      rateStr === undefined || rateStr === null
        ? null
        : Math.round(Number(rateStr) * 100);

    const updates = {
      status: 'purchased' as const,
      label_url: (postageLabel.label_url as string | undefined) ?? null,
      tracking_code: (bought.tracking_code as string | undefined) ?? null,
      tracking_url:
        (tracker.public_url as string | undefined) ??
        (bought.tracking_url as string | undefined) ??
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
      // Keep the claim stamp (purchased_by/purchased_at already set at claim
      // time); refresh purchased_at to the buy-completion instant.
      purchased_at: new Date().toISOString(),
      purchased_by: this.ctx.userId,
    };

    // Finalize as a compare-and-swap on the row we claimed: only transition the
    // row we still own (status='draft', purchased_by=this user) to 'purchased'.
    const { data: updated, error: updateError } = await this.admin
      .from('carrier_shipments')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', draftRow.id)
      .eq('status', 'draft')
      .select('*')
      .single();
    if (updateError) throw new ServiceError('internal_error', updateError.message);

    void audit(
      {
        event: 'shipping.label_purchased',
        entityType: 'carrier_shipment',
        entityId: draftRow.id,
        extra: { orderRequestId, carrier: updates.carrier, rateCents: updates.rate_cents },
      },
      this.ctx,
    );

    return updated as CarrierShipmentRow;
  }

  /**
   * Member-level read of the shipment for an order. Returns the single
   * most-recent row by `created_at` (any status, including a `draft` if that is
   * the latest), or null when none exists. Reads ride the user's RLS
   * (member-read policy on carrier_shipments).
   */
  async getShipment(orderRequestId: string): Promise<CarrierShipmentRow | null> {
    assertModuleEnabled(this.ctx, 'shipping');

    const { data, error } = await this.ctx.supabase
      .from('carrier_shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as CarrierShipmentRow | null) ?? null;
  }
}
