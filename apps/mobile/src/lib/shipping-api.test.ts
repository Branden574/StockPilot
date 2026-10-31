import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getOrderShipment, shipmentReadWanted } from './shipping-api';

/**
 * The order screen's carrier tracking is read only for an organization that
 * has the Shipping module.
 *
 * THE DEFECT (docket B10). getOrderShipment asked GET
 * /api/v1/orders/<id>/shipping on every order view. The read is module-gated
 * on the server (ShippingService.getShipment, assertModuleEnabled), so in an
 * organization without Shipping every order view got a 403 the phone then
 * ignored: a wasted round trip before the screen stopped loading, and a 403
 * in the server logs for every view (production log reviews 2026-10-11 and
 * 2026-10-12, Demo Co has Shipping off).
 */

// ./api and ./enabled-modules reach for the native client and SQLite at load.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);
const modulesMock = vi.hoisted(() => ({
  readPersistedEnabledModules: vi.fn(async (): Promise<Set<string> | null> => null),
}));
vi.mock('./enabled-modules', () => modulesMock);

const ORDER = '11111111-1111-1111-1111-111111111111';
const SHIPMENT = {
  id: 's1',
  carrier: 'UPS',
  service: 'Ground',
  tracking_code: '1Z',
  tracking_status: 'in_transit',
  tracking_url: 'https://tracking.example.com/1Z',
  label_url: null,
  status: 'in_transit',
};

beforeEach(() => {
  apiMock.api.mockReset();
  modulesMock.readPersistedEnabledModules.mockReset();
});

describe('getOrderShipment asks only where Shipping is on', () => {
  it('an organization without Shipping is not asked at all', async () => {
    modulesMock.readPersistedEnabledModules.mockResolvedValueOnce(new Set(['orders', 'inventory']));
    await expect(getOrderShipment(ORDER)).resolves.toBeNull();
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('an organization with Shipping reads the shipment', async () => {
    modulesMock.readPersistedEnabledModules.mockResolvedValueOnce(new Set(['orders', 'shipping']));
    apiMock.api.mockResolvedValueOnce({ shipment: SHIPMENT });
    await expect(getOrderShipment(ORDER)).resolves.toEqual(SHIPMENT);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/shipping`, {
      signal: undefined,
    });
  });

  it('before the first sync says which modules are on, it asks as it always did', async () => {
    modulesMock.readPersistedEnabledModules.mockResolvedValueOnce(null);
    apiMock.api.mockResolvedValueOnce({ shipment: null });
    await expect(getOrderShipment(ORDER)).resolves.toBeNull();
    expect(apiMock.api).toHaveBeenCalledTimes(1);
  });

  it('a module set it cannot read is not a reason to hide tracking', async () => {
    modulesMock.readPersistedEnabledModules.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    apiMock.api.mockResolvedValueOnce({ shipment: SHIPMENT });
    await expect(getOrderShipment(ORDER)).resolves.toEqual(SHIPMENT);
  });

  it('a refusal or a failed read still hides the section quietly', async () => {
    modulesMock.readPersistedEnabledModules.mockResolvedValueOnce(new Set(['shipping']));
    apiMock.api.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(getOrderShipment(ORDER)).resolves.toBeNull();
  });
});

describe('shipmentReadWanted', () => {
  it('reads with Shipping on, or while the module set is not known yet', () => {
    expect(shipmentReadWanted(new Set(['shipping']))).toBe(true);
    expect(shipmentReadWanted(null)).toBe(true);
  });

  it('does not read with Shipping off, including an empty module set', () => {
    expect(shipmentReadWanted(new Set(['orders']))).toBe(false);
    expect(shipmentReadWanted(new Set())).toBe(false);
  });
});
