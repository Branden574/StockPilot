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

// EasyPost client: createShipment + buyShipment are the two billable calls.
// Default happy-path returns are set in beforeEach so each test can override.
const createShipmentSpy = vi.fn(async (_body: unknown) => ({}) as Record<string, unknown>);
const buyShipmentSpy = vi.fn(
  async (_id: string, _rateId: string) => ({}) as Record<string, unknown>,
);
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
    buyShipment(id: string, rateId: string) {
      return buyShipmentSpy(id, rateId);
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

    // EasyPost buy invoked ONCE, with the draft's easypost shipment id + rate.
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);
    expect(buyShipmentSpy).toHaveBeenCalledWith('shp_easypost_1', 'rate_1');

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
    // Selects in order: (1) purchased guard -> none; (2) draft load -> draft;
    // (3) re-read after a lost claim -> the row the winner purchased.
    let selectCall = 0;
    const stub = makeSupabaseStub({
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
    // 'purchased'; this caller holds ship-2). Selects: (1) purchased guard ->
    // none yet; (2) draft load -> ship-2; (3) re-read after the 23505 -> the
    // winner's purchased row (ship-1).
    let selectCall = 0;
    const stub = makeSupabaseStub({
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
    // Selects: (1) purchased guard -> none; (2) draft load -> ship-2; (3) re-read
    // after the 23505 -> STILL no purchased row (the rival is mid-buy in
    // 'purchasing'). We must surface a retryable error, never reach EasyPost.
    let selectCall = 0;
    const stub = makeSupabaseStub({
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

  it('rolls the claim back to draft and surfaces a clear error when EasyPost buyShipment throws', async () => {
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
    // EasyPost buy fails (e.g. carrier 422 / transient 5xx).
    buyShipmentSpy.mockRejectedValueOnce(new Error('EasyPost buyShipment failed (status 422)'));

    const svc = new ShippingService(
      makeServiceContext(stub.client, { role: 'admin', enabledModules: SHIPPING_MODULES }),
    );

    await expect(svc.buyLabel('order-1', 'rate_1')).rejects.toMatchObject({
      code: 'validation_error',
    });

    // The buy was attempted exactly once and then failed.
    expect(buyShipmentSpy).toHaveBeenCalledTimes(1);

    // Updates fired: [0] the claim (draft -> purchasing), [1] the rollback
    // (purchasing -> draft, purchased_by cleared) — NO finalize to 'purchased'.
    const allUpdates = stub.chainArgsAll.get('carrier_shipments.update');
    expect(allUpdates).toHaveLength(2);
    const claimPayload = allUpdates?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(claimPayload).toMatchObject({ status: 'purchasing' });
    const rollbackPayload = allUpdates?.[1]?.[0]?.[0] as Record<string, unknown>;
    expect(rollbackPayload).toMatchObject({ status: 'draft', purchased_by: null });
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
