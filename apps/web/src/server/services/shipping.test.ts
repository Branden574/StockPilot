import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

// audit is side-effecting; stub it so the service runs in isolation.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

// The Vault key read goes through the service-role admin client + the
// connector secret RPCs. Stub getConnectionSecret to return a fake EasyPost
// key + webhook secret without touching Vault.
const getSecretSpy = vi.fn(async (_admin: unknown, _secretId: string) => ({
  apiKey: 'EZTK-test-key',
  webhookSecret: 'whsec-test',
  accessToken: 'EZTK-test-key',
  refreshToken: '',
  expiresAt: '',
}));
vi.mock('@/server/connectors/secret-store', () => ({
  getConnectionSecret: (admin: unknown, secretId: string) => getSecretSpy(admin, secretId),
}));

// EasyPost client: createShipment + buyShipment are the two billable calls;
// retrieveShipment is the non-billable GET used to reconcile an ambiguous buy.
// Default happy-path returns are set in beforeEach so each test can override.
const createShipmentSpy = vi.fn(async (_body: unknown) => ({}) as Record<string, unknown>);
const buyShipmentSpy = vi.fn(
  async (_id: string, _rateId: string, _idempotencyKey?: string) =>
    ({}) as Record<string, unknown>,
);
const retrieveShipmentSpy = vi.fn(async (_id: string) => ({}) as Record<string, unknown>);
vi.mock('@/server/connectors/easypost/client', () => ({
  EasyPostApiError: class EasyPostApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'EasyPostApiError';
      this.status = status;
    }
  },
  EasyPostClient: class EasyPostClient {
    constructor(_apiKey: string) {}
    createShipment(body: unknown) {
      return createShipmentSpy(body);
    }
    buyShipment(id: string, rateId: string, idempotencyKey?: string) {
      return buyShipmentSpy(id, rateId, idempotencyKey);
    }
    retrieveShipment(id: string) {
      return retrieveShipmentSpy(id);
    }
  },
}));

// The service writes/reads carrier_shipments through the SERVICE-ROLE admin
// client. We point createAdminClient() at a mutable holder each test fills with
// a makeSupabaseStub client so those .from('carrier_shipments') chains resolve.
const adminClientHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminClientHolder.client),
}));

import { EasyPostApiError } from '@/server/connectors/easypost/client';
import { ShippingService } from './shipping';
import { ServiceError } from './context';

const SHIPPING_MODULES = new Set<ModuleId>(['shipping']);

const WAREHOUSE_ADDRESS = {
  line1: '100 Depot Rd',
  line2: 'Dock 4',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  country: 'US',
};

const CHARTER_ADDRESS = {
  line1: '200 Campus Way',
  city: 'Dallas',
  region: 'TX',
  postalCode: '75201',
};

const PARCEL = { weight_oz: 32, length_in: 10, width_in: 8, height_in: 4 };

/**
 * Builds a stub configured for a delivery order whose warehouse + charter
 * both have an address and an active easypost connection. Individual tests
 * override `charters.select` to drop the address, etc.
 */
function makeDeliveryStub(overrides: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'order_requests.select': {
      data: [
        {
          id: 'order-1',
          organization_id: 'org-test',
          fulfillment_type: 'delivery',
          delivery_charter_id: 'charter-1',
          warehouse_id: 'wh-1',
        },
      ],
      error: null,
    },
    'warehouses.select': {
      data: [{ id: 'wh-1', name: 'Main', address: WAREHOUSE_ADDRESS }],
      error: null,
    },
    'charters.select': {
      data: [{ id: 'charter-1', name: 'North Charter', address: CHARTER_ADDRESS }],
      error: null,
    },
    'org_connections.select': {
      data: [{ id: 'conn-1', provider_id: 'easypost', status: 'active', secret_id: 'secret-1' }],
      error: null,
    },
    'carrier_shipments.insert': {
      data: [{ id: 'ship-1' }],
      error: null,
    },
    'carrier_shipments.update': { data: [{ id: 'ship-1' }], error: null },
    ...overrides,
  });
  // The admin (service-role) client shares the same stub: carrier_shipments
  // keys are distinct from the user-RLS reads so one stub serves both clients.
  adminClientHolder.client = stub.client;
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSecretSpy.mockResolvedValue({
    apiKey: 'EZTK-test-key',
    webhookSecret: 'whsec-test',
    accessToken: 'EZTK-test-key',
    refreshToken: '',
    expiresAt: '',
  });
  createShipmentSpy.mockResolvedValue({
    id: 'shp_easypost_1',
    rates: [
      {
        id: 'rate_1',
        carrier: 'USPS',
        service: 'Priority',
        rate: '8.45',
        currency: 'USD',
        delivery_days: 2,
      },
      {
        id: 'rate_2',
        carrier: 'UPS',
        service: 'Ground',
        rate: '10.10',
        currency: 'USD',
        delivery_days: 3,
      },
    ],
  });
  buyShipmentSpy.mockResolvedValue({
    id: 'shp_easypost_1',
    tracking_code: '1Z999',
    selected_rate: {
      id: 'rate_1',
      carrier: 'USPS',
      service: 'Priority',
      rate: '8.45',
      currency: 'USD',
    },
    postage_label: { label_url: 'https://easypost/label.pdf' },
    tracker: { public_url: 'https://track/1Z999' },
  });
  // Default reconcile GET: shipment with NO label (the buy never completed) so
  // the ambiguous-failure path rolls back unless a test overrides it.
  retrieveShipmentSpy.mockResolvedValue({ id: 'shp_easypost_1' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ShippingService.getRates', () => {
  it('throws validation_error when the destination charter has no address', async () => {
    const stub = makeDeliveryStub({
      'charters.select': {
        data: [{ id: 'charter-1', name: 'North Charter', address: null }],
        error: null,
      },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.getRates('order-1', PARCEL)).rejects.toMatchObject({
      code: 'validation_error',
    });
    // No EasyPost call should have happened.
    expect(createShipmentSpy).not.toHaveBeenCalled();
  });

  it('assembles from/to addresses (region -> state), creates the shipment, and maps rates', async () => {
    const stub = makeDeliveryStub();
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.getRates('order-1', PARCEL);

    expect(createShipmentSpy).toHaveBeenCalledTimes(1);
    const firstCall = createShipmentSpy.mock.calls[0];
    if (!firstCall) throw new Error('createShipment was not called');
    const body = firstCall[0] as {
      shipment: {
        from_address: Record<string, unknown>;
        to_address: Record<string, unknown>;
        parcel: Record<string, unknown>;
      };
    };
    // region -> state mapping; line1 -> street1.
    expect(body.shipment.from_address).toMatchObject({
      street1: '100 Depot Rd',
      street2: 'Dock 4',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      country: 'US',
    });
    expect(body.shipment.to_address).toMatchObject({
      street1: '200 Campus Way',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      country: 'US',
    });
    expect(body.shipment.parcel).toMatchObject({ weight: 32 });

    expect(result.easypostShipmentId).toBe('shp_easypost_1');
    expect(result.rates).toHaveLength(2);
    expect(result.rates[0]).toMatchObject({
      id: 'rate_1',
      carrier: 'USPS',
      service: 'Priority',
      rate: '8.45',
      currency: 'USD',
      delivery_days: 2,
    });
    // A draft carrier_shipments row was written.
    expect(stub.fromCalls).toContain('carrier_shipments');
  });
});

describe('ShippingService.buyLabel', () => {
  it('returns the existing purchased shipment without a second EasyPost buy (idempotent)', async () => {
    const purchasedRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'purchased',
      easypost_shipment_id: 'shp_easypost_1',
      tracking_code: '1Z999',
      label_url: 'https://easypost/label.pdf',
      carrier: 'USPS',
      service: 'Priority',
      rate_cents: 845,
    };
    const stub = makeSupabaseStub({
      'carrier_shipments.select': { data: [purchasedRow], error: null },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyLabel('order-1', 'rate_1');

    expect(result).toMatchObject({ id: 'ship-1', status: 'purchased' });
    // The idempotency guard must short-circuit before any EasyPost buy.
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });

  it('claims the draft to purchasing, buys the rate ONCE, then finalizes to purchased (happy path)', async () => {
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    // buyLabel issues two carrier_shipments selects in order: (1) purchased
    // guard -> none; (2) draft load -> the draft row. A call-counting result
    // distinguishes them. buyLabel also calls resolveShippingContext (order +
    // charter + warehouse + connection reads), so build on the full delivery
    // stub.
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1
          ? { data: [], error: null } // purchased guard: no purchased row yet
          : { data: [draftRow], error: null }; // draft load
      },
      // Both the claim UPDATE (-> purchasing) and the finalize UPDATE
      // (-> purchased) return one row: the claim wins, the finalize succeeds.
      'carrier_shipments.update': { data: [{ id: 'ship-1' }], error: null },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyLabel('order-1', 'rate_1');

    // EasyPost buy invoked ONCE, with the draft's easypost shipment id + rate +
    // the row id as the Idempotency-Key (so a retried buy can't double-charge).
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);
    expect(buyShipmentSpy).toHaveBeenCalledWith('shp_easypost_1', 'rate_1', 'ship-1');

    // Two carrier_shipments updates fired: [0] the claim (draft -> purchasing),
    // [1] the finalize (purchasing -> purchased).
    const allUpdates = stub.chainArgsAll.get('carrier_shipments.update');
    expect(allUpdates).toHaveLength(2);

    // CLAIM payload: transitions to 'purchasing' and stamps the actor BEFORE the
    // billable EasyPost call (the airtight gate against double-buy).
    const claimPayload = allUpdates?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(claimPayload).toMatchObject({ status: 'purchasing', purchased_by: 'user-test' });

    // FINALIZE payload: rate_cents = round(rate*100); label/tracking fallbacks.
    const finalizePayload = allUpdates?.[1]?.[0]?.[0] as Record<string, unknown>;
    expect(finalizePayload).toMatchObject({
      status: 'purchased',
      label_url: 'https://easypost/label.pdf',
      tracking_code: '1Z999',
      tracking_url: 'https://track/1Z999',
      carrier: 'USPS',
      service: 'Priority',
      rate_cents: 845,
      currency: 'USD',
      easypost_rate_id: 'rate_1',
      purchased_by: 'user-test',
    });
    expect(result).toBeTruthy();
  });

  it('does not re-buy when the claim updates ZERO rows (returns the winner purchased row)', async () => {
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    const winnerPurchased = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'purchased',
      easypost_shipment_id: 'shp_easypost_1',
      tracking_code: '1Z999',
    };
    // buyLabel now RESOLVES the EasyPost context (order/charter/warehouse/
    // connection reads) BEFORE the claim, so build on the full delivery stub.
    // carrier_shipments selects in order: (1) purchased guard -> none; (2) draft
    // load -> draft; (3) re-read after a lost claim -> the winner's purchased row.
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        if (selectCall === 1) return { data: [], error: null };
        if (selectCall === 2) return { data: [draftRow], error: null };
        return { data: [winnerPurchased], error: null };
      },
      // The claim updates ZERO rows (the row was no longer 'draft') -> lost race.
      'carrier_shipments.update': { data: [], error: null },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyLabel('order-1', 'rate_1');

    // Lost the claim -> NO EasyPost buy, returns the winner's purchased row.
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'ship-1', status: 'purchased' });
  });

  it('does not re-buy when the claim hits the partial-unique-index conflict (23505) and returns the winner row', async () => {
    const draftRow = {
      id: 'ship-2',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_2',
      currency: 'USD',
      purchased_by: null,
    };
    const winnerPurchased = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'purchased',
      easypost_shipment_id: 'shp_easypost_1',
      tracking_code: '1Z999',
    };
    // Two getRates sessions made two distinct drafts (ship-1 already won + is
    // 'purchased'; this caller holds ship-2). buyLabel resolves the EasyPost
    // context before claiming, so build on the full delivery stub.
    // carrier_shipments selects: (1) purchased guard -> none yet; (2) draft load
    // -> ship-2; (3) re-read after the 23505 -> the winner's purchased row (ship-1).
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        if (selectCall === 1) return { data: [], error: null };
        if (selectCall === 2) return { data: [draftRow], error: null };
        return { data: [winnerPurchased], error: null };
      },
      // The claim's transition into 'purchasing' violates
      // carrier_shipments_one_active_per_order (a rival already owns the order's
      // active-buy slot) -> Postgres unique_violation 23505.
      'carrier_shipments.update': {
        data: null,
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "carrier_shipments_one_active_per_order"',
        },
      },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyLabel('order-1', 'rate_1');

    // The 23505 must be CAUGHT (not 500) -> no EasyPost buy, winner row returned.
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'ship-1', status: 'purchased' });
  });

  it('throws an "in progress" error when the claim loses but the rival has not finished buying', async () => {
    const draftRow = {
      id: 'ship-2',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_2',
      currency: 'USD',
      purchased_by: null,
    };
    // buyLabel resolves the EasyPost context before claiming, so build on the
    // full delivery stub. carrier_shipments selects: (1) purchased guard ->
    // none; (2) draft load -> ship-2; (3) re-read after the 23505 -> STILL no
    // purchased row (the rival is mid-buy in 'purchasing'). We must surface a
    // retryable error, never reach EasyPost.
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        if (selectCall === 2) return { data: [draftRow], error: null };
        return { data: [], error: null };
      },
      'carrier_shipments.update': {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({
      code: 'validation_error',
      message: 'A label purchase is already in progress for this order',
    });
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });

  it('rolls the claim back to draft on a definitive 4xx (no charge) without reconciling', async () => {
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1 ? { data: [], error: null } : { data: [draftRow], error: null };
      },
      // Claim wins (one row); the rollback update also succeeds.
      'carrier_shipments.update': { data: [{ id: 'ship-1' }], error: null },
    });
    adminClientHolder.client = stub.client;
    // EasyPost buy fails with a DEFINITIVE 422 — the carrier rejected the request
    // before charging, so it is safe to reopen the draft without reconciling.
    buyShipmentSpy.mockRejectedValueOnce(
      new EasyPostApiError('EasyPost buyShipment failed (status 422)', 422),
    );

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({
      code: 'validation_error',
    });

    // The buy was attempted exactly once and then failed.
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);
    // A definitive 4xx proves no charge -> NO reconcile GET.
    expect(retrieveShipmentSpy).not.toHaveBeenCalled();

    // Updates fired: [0] the claim (draft -> purchasing), [1] the rollback
    // (purchasing -> draft, purchased_by cleared) — NO finalize to 'purchased'.
    const allUpdates = stub.chainArgsAll.get('carrier_shipments.update');
    expect(allUpdates).toHaveLength(2);
    const claimPayload = allUpdates?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(claimPayload).toMatchObject({ status: 'purchasing' });
    const rollbackPayload = allUpdates?.[1]?.[0]?.[0] as Record<string, unknown>;
    expect(rollbackPayload).toMatchObject({ status: 'draft', purchased_by: null });
  });

  it('reconciles an ambiguous failure (5xx): finalizes to purchased when the label exists', async () => {
    // A transient 5xx (or timeout) where EasyPost actually completed the buy
    // server-side. The reconcile GET shows a postage_label -> finalize to
    // 'purchased' instead of re-buying (which would double-charge) or losing the
    // paid label.
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1 ? { data: [], error: null } : { data: [draftRow], error: null };
      },
      'carrier_shipments.update': { data: [{ id: 'ship-1', status: 'purchased' }], error: null },
    });
    adminClientHolder.client = stub.client;
    buyShipmentSpy.mockRejectedValueOnce(
      new EasyPostApiError('EasyPost buyShipment failed (status 503)', 503),
    );
    // Reconcile GET: the buy DID complete at the carrier.
    retrieveShipmentSpy.mockResolvedValueOnce({
      id: 'shp_easypost_1',
      tracking_code: '1Z999',
      selected_rate: { id: 'rate_1', carrier: 'USPS', service: 'Priority', rate: '8.45', currency: 'USD' },
      postage_label: { label_url: 'https://easypost/label.pdf' },
      tracker: { public_url: 'https://track/1Z999' },
    });

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyLabel('order-1', 'rate_1');

    // Reconciled via GET, did NOT re-buy, and finalized the paid label.
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);
    expect(retrieveShipmentSpy).toHaveBeenCalledTimes(1);
    const allUpdates = stub.chainArgsAll.get('carrier_shipments.update');
    expect(allUpdates).toHaveLength(2); // claim + finalize (no rollback)
    const finalizePayload = allUpdates?.[1]?.[0]?.[0] as Record<string, unknown>;
    expect(finalizePayload).toMatchObject({
      status: 'purchased',
      label_url: 'https://easypost/label.pdf',
      tracking_code: '1Z999',
    });
    expect(result).toBeTruthy();
  });

  it('reconciles an ambiguous failure (5xx): rolls back to draft when NO label exists', async () => {
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1 ? { data: [], error: null } : { data: [draftRow], error: null };
      },
      'carrier_shipments.update': { data: [{ id: 'ship-1' }], error: null },
    });
    adminClientHolder.client = stub.client;
    buyShipmentSpy.mockRejectedValueOnce(
      new EasyPostApiError('EasyPost buyShipment failed (status 503)', 503),
    );
    // Reconcile GET (default beforeEach return): no postage_label -> no charge.

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(retrieveShipmentSpy).toHaveBeenCalledTimes(1);
    const allUpdates = stub.chainArgsAll.get('carrier_shipments.update');
    expect(allUpdates).toHaveLength(2); // claim + rollback
    const rollbackPayload = allUpdates?.[1]?.[0]?.[0] as Record<string, unknown>;
    expect(rollbackPayload).toMatchObject({ status: 'draft', purchased_by: null });
  });

  it('leaves the row purchasing (no rollback) when the buy AND the reconcile both fail', async () => {
    // Ambiguous buy failure where even the reconcile GET fails. The row must
    // stay 'purchasing' (a possibly-charged buy is never blindly re-bought) and
    // the error must point at the recovery path — NO rollback update fires.
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1 ? { data: [], error: null } : { data: [draftRow], error: null };
      },
      'carrier_shipments.update': { data: [{ id: 'ship-1' }], error: null },
    });
    adminClientHolder.client = stub.client;
    buyShipmentSpy.mockRejectedValueOnce(
      new EasyPostApiError('EasyPost buyShipment failed (status 503)', 503),
    );
    retrieveShipmentSpy.mockRejectedValueOnce(
      new EasyPostApiError('EasyPost retrieveShipment failed (status 503)', 503),
    );

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(retrieveShipmentSpy).toHaveBeenCalledTimes(1);
    // ONLY the claim update fired — no rollback (the row stays 'purchasing').
    const allUpdates = stub.chainArgsAll.get('carrier_shipments.update');
    expect(allUpdates).toHaveLength(1);
    const claimPayload = allUpdates?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(claimPayload).toMatchObject({ status: 'purchasing' });
  });

  it('leaves the order stuck purchasing when resolveShippingContext throws BEFORE the claim', async () => {
    // The active EasyPost connection was disconnected between getRates and
    // buyLabel. Because we resolve the context BEFORE claiming, the throw lands
    // while the row is still 'draft' — NO claim update fires, so the order is
    // never stranded in 'purchasing'.
    const draftRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'draft',
      easypost_shipment_id: 'shp_easypost_1',
      currency: 'USD',
      purchased_by: null,
    };
    let selectCall = 0;
    const stub = makeDeliveryStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1 ? { data: [], error: null } : { data: [draftRow], error: null };
      },
      // No active EasyPost connection -> resolveShippingContext throws.
      'org_connections.select': { data: [], error: null },
      'carrier_shipments.update': { data: [{ id: 'ship-1' }], error: null },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({
      code: 'validation_error',
    });
    // Never bought, and crucially NEVER claimed (no update fired) -> not stuck.
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    expect(stub.chainArgsAll.get('carrier_shipments.update')).toBeUndefined();
  });

  it('blocks a manager (no shipping:manage) from buying a label', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: SHIPPING_MODULES }),
    );
    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });
});

describe('ShippingService.buyReturnLabel', () => {
  const approvedReturn = {
    id: 'ret-1',
    organization_id: 'org-test',
    order_request_id: 'order-1',
    status: 'approved' as const,
  };

  /**
   * The return-label flow does its own one-shot createShipment (no separate
   * rate-shop step), claims a direction='return' row into 'purchasing', then
   * buys the cheapest rate. The default createShipment return already carries
   * rates; buyShipment returns the purchased shipment. Build on the full
   * delivery stub so resolveShippingContext (order/charter/warehouse/connection)
   * succeeds, and add a returns.select result so the return loads.
   */
  function makeReturnStub(overrides: Record<string, unknown> = {}) {
    return makeDeliveryStub({
      'returns.select': { data: [approvedReturn], error: null },
      ...overrides,
    });
  }

  // The parcel persisted on the order's forward outbound shipment, reused for
  // the reverse label (EasyPost shape: weight/length/width/height).
  const OUTBOUND_PARCEL = { weight: 32, length: 10, width: 8, height: 4 };

  it('builds an is_return shipment with REVERSED addresses (to=warehouse, from=charter), reuses the outbound parcel, and buys ONCE', async () => {
    // carrier_shipments selects in order: (1) purchased-return guard -> none;
    // (2) loadOutboundParcel -> the outbound row carrying the parcel. The insert
    // then creates the return draft, and the claim + finalize updates fire.
    let selectCall = 0;
    const stub = makeReturnStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1
          ? { data: [], error: null } // purchased-return guard: none yet
          : { data: [{ parcel: OUTBOUND_PARCEL }], error: null }; // outbound parcel
      },
      'carrier_shipments.insert': { data: [{ id: 'ret-ship-1' }], error: null },
      'carrier_shipments.update': { data: [{ id: 'ret-ship-1' }], error: null },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyReturnLabel('ret-1');

    // ONE createShipment with is_return:true and the addresses SWAPPED relative
    // to the outbound label: to = warehouse origin, from = charter destination.
    expect(createShipmentSpy).toHaveBeenCalledTimes(1);
    const body = createShipmentSpy.mock.calls[0]?.[0] as {
      shipment: {
        is_return?: boolean;
        to_address: Record<string, unknown>;
        from_address: Record<string, unknown>;
        parcel?: Record<string, unknown>;
      };
    };
    expect(body.shipment.is_return).toBe(true);
    // to_address = warehouse origin (reversed).
    expect(body.shipment.to_address).toMatchObject({ street1: '100 Depot Rd', city: 'Austin', zip: '78701' });
    // from_address = charter destination (reversed).
    expect(body.shipment.from_address).toMatchObject({ street1: '200 Campus Way', city: 'Dallas', zip: '75201' });
    // The outbound parcel is REUSED — EasyPost will not rate a parcel-less shipment.
    expect(body.shipment.parcel).toMatchObject(OUTBOUND_PARCEL);

    // EasyPost buy invoked ONCE, keyed with the draft row id as the
    // Idempotency-Key, against the created shipment's cheapest rate (rate_1, $8.45).
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);
    expect(buyShipmentSpy).toHaveBeenCalledWith('shp_easypost_1', 'rate_1', 'ret-ship-1');

    // The draft was inserted with direction='return' (independent of any outbound
    // label, per the 0156 per-direction unique index) AND with the reused parcel
    // persisted on it.
    const insertPayload = stub.chainArgsAll.get('carrier_shipments.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(insertPayload).toMatchObject({
      order_request_id: 'order-1',
      direction: 'return',
      status: 'draft',
      parcel: OUTBOUND_PARCEL,
    });

    expect(result).toBeTruthy();
  });

  it('REGRESSION: createShipment is called WITH a parcel so EasyPost returns rates (missing-parcel produces no label)', async () => {
    // Guards the B2 defect: a parcel-less return createShipment comes back with
    // empty rates[], pickCheapestRate returns null, and the buy can never produce
    // a label. Here the createShipment mock returns rates ONLY when a parcel is
    // present; with the fix in place (the outbound parcel is reused) the buy
    // completes. Without it, this test would fail at the 'No return rates'
    // validation_error path.
    createShipmentSpy.mockImplementation(async (body: unknown) => {
      const shipment = (body as { shipment?: { parcel?: unknown } }).shipment;
      if (!shipment?.parcel) {
        // EasyPost cannot rate a shipment without parcel dimensions.
        return { id: 'shp_easypost_1', rates: [] } as Record<string, unknown>;
      }
      return {
        id: 'shp_easypost_1',
        rates: [
          { id: 'rate_1', carrier: 'USPS', service: 'Priority', rate: '8.45', currency: 'USD', delivery_days: 2 },
        ],
      } as Record<string, unknown>;
    });

    let selectCall = 0;
    const stub = makeReturnStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1
          ? { data: [], error: null }
          : { data: [{ parcel: OUTBOUND_PARCEL }], error: null };
      },
      'carrier_shipments.insert': { data: [{ id: 'ret-ship-1' }], error: null },
      'carrier_shipments.update': { data: [{ id: 'ret-ship-1' }], error: null },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyReturnLabel('ret-1');

    // A parcel WAS sent -> EasyPost returned a rate -> the buy completed.
    const body = createShipmentSpy.mock.calls[0]?.[0] as { shipment: { parcel?: unknown } };
    expect(body.shipment.parcel).toBeTruthy();
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);
    expect(result).toBeTruthy();
  });

  it('fails cleanly (no EasyPost call, no stray draft) when the order has no outbound parcel to reuse', async () => {
    // No forward outbound shipment was ever rated/bought, so loadOutboundParcel
    // finds nothing. The return must fail BEFORE inserting a draft or touching
    // EasyPost — a parcel-less shipment could never produce a label anyway.
    let selectCall = 0;
    const stub = makeReturnStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1
          ? { data: [], error: null } // purchased-return guard: none
          : { data: [], error: null }; // loadOutboundParcel: no outbound parcel
      },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyReturnLabel('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
    // Failed up-front: no shipment created, no buy, no draft inserted.
    expect(createShipmentSpy).not.toHaveBeenCalled();
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    expect(stub.chainArgsAll.get('carrier_shipments.insert')).toBeUndefined();
  });

  it('is idempotent: returns the existing purchased return label without a second buy', async () => {
    const purchasedReturn = {
      id: 'ret-ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      direction: 'return',
      status: 'purchased',
      easypost_shipment_id: 'shp_easypost_1',
      label_url: 'https://easypost/return-label.pdf',
      tracking_code: '1ZRET',
    };
    const stub = makeReturnStub({
      'carrier_shipments.select': { data: [purchasedReturn], error: null },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.buyReturnLabel('ret-1');

    expect(result).toMatchObject({ id: 'ret-ship-1', status: 'purchased', direction: 'return' });
    // The idempotency guard short-circuits BEFORE any EasyPost call.
    expect(createShipmentSpy).not.toHaveBeenCalled();
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });

  it('rejects a return that is not approved/received', async () => {
    const stub = makeReturnStub({
      'returns.select': {
        data: [{ ...approvedReturn, status: 'requested' }],
        error: null,
      },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyReturnLabel('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
    expect(createShipmentSpy).not.toHaveBeenCalled();
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });

  it('throws not_found for a missing return', async () => {
    const stub = makeReturnStub({ 'returns.select': { data: [], error: null } });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyReturnLabel('ret-1')).rejects.toMatchObject({ code: 'not_found' });
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });

  it('blocks a manager (no shipping:manage) from buying a return label', async () => {
    const stub = makeReturnStub();
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: SHIPPING_MODULES }),
    );
    await expect(svc.buyReturnLabel('ret-1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });

  it('throws module_disabled when shipping is off', async () => {
    const stub = makeReturnStub();
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: new Set<ModuleId>() }),
    );
    await expect(svc.buyReturnLabel('ret-1')).rejects.toMatchObject({ code: 'module_disabled' });
    expect(buyShipmentSpy).not.toHaveBeenCalled();
  });
});

describe('ShippingService.reconcilePurchasing (stuck-row recovery)', () => {
  const stuckRow = {
    id: 'ship-1',
    organization_id: 'org-test',
    order_request_id: 'order-1',
    status: 'purchasing',
    easypost_shipment_id: 'shp_easypost_1',
    currency: 'USD',
    purchased_by: 'user-test',
  };

  it('finalizes a stranded purchasing row to purchased when EasyPost shows the label', async () => {
    const stub = makeDeliveryStub({
      'carrier_shipments.select': { data: [stuckRow], error: null },
      'carrier_shipments.update': { data: [{ id: 'ship-1', status: 'purchased' }], error: null },
    });
    adminClientHolder.client = stub.client;
    retrieveShipmentSpy.mockResolvedValueOnce({
      id: 'shp_easypost_1',
      tracking_code: '1Z999',
      selected_rate: { id: 'rate_1', carrier: 'USPS', service: 'Priority', rate: '8.45', currency: 'USD' },
      postage_label: { label_url: 'https://easypost/label.pdf' },
      tracker: { public_url: 'https://track/1Z999' },
    });

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.reconcilePurchasing('order-1');

    expect(retrieveShipmentSpy).toHaveBeenCalledWith('shp_easypost_1');
    // Never re-buys; finalizes the existing (charged) label.
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    const updatePayload = stub.chainArgsAll.get('carrier_shipments.update')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload).toMatchObject({ status: 'purchased', label_url: 'https://easypost/label.pdf' });
    expect(result).toBeTruthy();
  });

  it('resets a stranded purchasing row to draft when EasyPost shows NO label', async () => {
    const stub = makeDeliveryStub({
      'carrier_shipments.select': { data: [stuckRow], error: null },
      'carrier_shipments.update': { data: [{ id: 'ship-1', status: 'draft' }], error: null },
    });
    adminClientHolder.client = stub.client;
    retrieveShipmentSpy.mockResolvedValueOnce({ id: 'shp_easypost_1' }); // no label

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.reconcilePurchasing('order-1');

    expect(result).toBeNull();
    const updatePayload = stub.chainArgsAll.get('carrier_shipments.update')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload).toMatchObject({ status: 'draft', purchased_by: null });
  });

  it('returns the purchased row (no-op) when nothing is stranded', async () => {
    const purchasedRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'purchased',
      easypost_shipment_id: 'shp_easypost_1',
    };
    // First select (stuck 'purchasing' lookup) -> none; second (findPurchased) -> the row.
    let selectCall = 0;
    const stub = makeSupabaseStub({
      'carrier_shipments.select': () => {
        selectCall += 1;
        return selectCall === 1 ? { data: [], error: null } : { data: [purchasedRow], error: null };
      },
    });
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.reconcilePurchasing('order-1');

    expect(retrieveShipmentSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'ship-1', status: 'purchased' });
  });

  it('is gated: blocks a manager without shipping:manage', async () => {
    const stub = makeSupabaseStub({});
    adminClientHolder.client = stub.client;
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: SHIPPING_MODULES }),
    );
    await expect(svc.reconcilePurchasing('order-1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(retrieveShipmentSpy).not.toHaveBeenCalled();
  });
});

describe('ShippingService.reapStuckShipment (service-role reaper)', () => {
  const stuckRow = {
    id: 'ship-1',
    organization_id: 'org-test',
    order_request_id: 'order-1',
    status: 'purchasing' as const,
    easypost_shipment_id: 'shp_easypost_1',
    currency: 'USD',
    purchased_by: 'user-test',
  };

  it('finalizes a stale purchasing row to purchased when EasyPost shows the label', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-1', secret_id: 'secret-1' }],
        error: null,
      },
      'carrier_shipments.update': { data: [{ id: 'ship-1', status: 'purchased' }], error: null },
    });
    retrieveShipmentSpy.mockResolvedValueOnce({
      id: 'shp_easypost_1',
      tracking_code: '1Z999',
      selected_rate: { id: 'rate_1', carrier: 'USPS', service: 'Priority', rate: '8.45', currency: 'USD' },
      postage_label: { label_url: 'https://easypost/label.pdf' },
      tracker: { public_url: 'https://track/1Z999' },
    });

    const outcome = await ShippingService.reapStuckShipment(
      stub.client as never,
      stuckRow as never,
    );

    expect(outcome).toBe('purchased');
    expect(retrieveShipmentSpy).toHaveBeenCalledWith('shp_easypost_1');
    // NEVER re-buys — only copies the already-charged label.
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    const updatePayload = stub.chainArgsAll.get('carrier_shipments.update')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload).toMatchObject({
      status: 'purchased',
      label_url: 'https://easypost/label.pdf',
      tracking_code: '1Z999',
      rate_cents: 845,
    });
  });

  it('resets a stale purchasing row to draft when EasyPost shows NO label', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-1', secret_id: 'secret-1' }],
        error: null,
      },
      'carrier_shipments.update': { data: [{ id: 'ship-1', status: 'draft' }], error: null },
    });
    retrieveShipmentSpy.mockResolvedValueOnce({ id: 'shp_easypost_1' }); // no label

    const outcome = await ShippingService.reapStuckShipment(
      stub.client as never,
      stuckRow as never,
    );

    expect(outcome).toBe('draft');
    expect(buyShipmentSpy).not.toHaveBeenCalled();
    const updatePayload = stub.chainArgsAll.get('carrier_shipments.update')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload).toMatchObject({ status: 'draft', purchased_by: null });
  });

  it('skips (leaves purchasing) when the org has no active EasyPost connection', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': { data: [], error: null },
    });

    const outcome = await ShippingService.reapStuckShipment(
      stub.client as never,
      stuckRow as never,
    );

    // Can't confirm whether the carrier charged -> must NOT reset to draft.
    expect(outcome).toBe('skipped');
    expect(retrieveShipmentSpy).not.toHaveBeenCalled();
    expect(stub.chainArgsAll.get('carrier_shipments.update')).toBeUndefined();
  });

  it('skips (leaves purchasing) when the row has no easypost_shipment_id', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-1', secret_id: 'secret-1' }],
        error: null,
      },
    });

    const outcome = await ShippingService.reapStuckShipment(
      stub.client as never,
      { ...stuckRow, easypost_shipment_id: null } as never,
    );

    expect(outcome).toBe('skipped');
    expect(retrieveShipmentSpy).not.toHaveBeenCalled();
    expect(stub.chainArgsAll.get('carrier_shipments.update')).toBeUndefined();
  });
});

describe('ShippingService.getShipment', () => {
  it('returns null for a draft-only order (no phantom unpurchased shipment)', async () => {
    // The query filters with .in('status', [non-draft statuses]); a draft-only
    // order therefore matches nothing -> the DB returns no row. The stub does
    // not itself filter, so we model that by returning an empty result.
    const stub = makeSupabaseStub({
      'carrier_shipments.select': { data: [], error: null },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'staff', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.getShipment('order-1');

    expect(result).toBeNull();
    // The read must scope to NON-draft statuses (excludes 'draft').
    const chain = stub.chains.get('carrier_shipments.select');
    expect(chain).toContain('in');
    const args = stub.chainArgs.get('carrier_shipments.select');
    const inCall = args?.[chain?.indexOf('in') ?? -1];
    expect(inCall?.[0]).toBe('status');
    const statuses = inCall?.[1] as string[];
    expect(statuses).not.toContain('draft');
    // A mid-buy 'purchasing' row (0150) must ALSO be excluded — it is not a real
    // shipment yet.
    expect(statuses).not.toContain('purchasing');
    expect(statuses).toContain('purchased');
  });

  it('returns the purchased row for a purchased order', async () => {
    const purchasedRow = {
      id: 'ship-1',
      organization_id: 'org-test',
      order_request_id: 'order-1',
      status: 'purchased',
      easypost_shipment_id: 'shp_easypost_1',
      tracking_code: '1Z999',
      label_url: 'https://easypost/label.pdf',
      carrier: 'USPS',
      service: 'Priority',
      rate_cents: 845,
    };
    const stub = makeSupabaseStub({
      'carrier_shipments.select': { data: [purchasedRow], error: null },
    });
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'staff', enabledModules: SHIPPING_MODULES }),
    );

    const result = await svc.getShipment('order-1');

    expect(result).toMatchObject({ id: 'ship-1', status: 'purchased' });
  });
});

describe('module + permission gating', () => {
  it('getRates throws module_disabled when shipping is off', async () => {
    const stub = makeDeliveryStub();
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: new Set<ModuleId>() }),
    );
    await expect(svc.getRates('order-1', PARCEL)).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.getRates('order-1', PARCEL)).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('getRates throws forbidden for a member without shipping:manage', async () => {
    const stub = makeDeliveryStub();
    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'staff', enabledModules: SHIPPING_MODULES }),
    );
    await expect(svc.getRates('order-1', PARCEL)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
