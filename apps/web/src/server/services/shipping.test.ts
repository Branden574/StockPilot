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
