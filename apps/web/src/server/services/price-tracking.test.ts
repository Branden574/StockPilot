import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { PriceTrackingService, recordBookObservation, refreshBookPricesForOrg } from './price-tracking';

const withPT = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'price_tracking']);
const fakeClient = (json: unknown) => ({ fetchVolumeByIsbn: vi.fn(async () => json) });
const PRICED = {
  items: [{ volumeInfo: { title: 'B' }, saleInfo: { saleability: 'FOR_SALE', listPrice: { amount: 9.99, currencyCode: 'USD' }, retailPrice: { amount: 7.99, currencyCode: 'USD' } } }],
};

describe('PriceTrackingService gate', () => {
  it('throws module_disabled when price_tracking is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new PriceTrackingService(makeServiceContext(stub.client)); // no price_tracking
    await expect(svc.fetchItemPrice('item-1')).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('recordBookObservation', () => {
  it('writes an observation for an ISBN item with data', async () => {
    const stub = makeSupabaseStub({ 'item_price_observations.insert': { data: null, error: null } });
    const wrote = await recordBookObservation(
      stub.client, 'org-1', { id: 'i1', barcode: '9780306406157' }, fakeClient(PRICED),
    );
    expect(wrote).toBe(true);
    expect(stub.fromCalls).toContain('item_price_observations');
  });
  it('skips a non-ISBN barcode (no fetch, no write)', async () => {
    const stub = makeSupabaseStub({});
    const client = fakeClient(PRICED);
    const wrote = await recordBookObservation(stub.client, 'org-1', { id: 'i1', barcode: 'NOTISBN' }, client);
    expect(wrote).toBe(false);
    expect(client.fetchVolumeByIsbn).not.toHaveBeenCalled();
  });
  it('skips when the API returns no data', async () => {
    const stub = makeSupabaseStub({});
    const wrote = await recordBookObservation(stub.client, 'org-1', { id: 'i1', barcode: '9780306406157' }, fakeClient(null));
    expect(wrote).toBe(false);
  });
});

describe('refreshBookPricesForOrg', () => {
  it('prices never-priced ISBN books, skips non-ISBN and recently-priced rows', async () => {
    const items = [
      { id: 'i1', barcode: '9780306406157', last_priced_at: null }, // never priced → priced
      { id: 'i2', barcode: 'NOTISBN', last_priced_at: null }, // not an ISBN → skipped, no fetch
      { id: 'i3', barcode: '0306406152', last_priced_at: new Date().toISOString() }, // recent → skipped, no fetch
    ];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: items, error: null },
      'inventory_items.update': { data: null, error: null },
      'item_price_observations.insert': { data: null, error: null },
    });
    const client = fakeClient(PRICED);

    const res = await refreshBookPricesForOrg(stub.client, 'org-1', client, { limit: 50 });

    expect(res.scanned).toBe(3);
    expect(res.written).toBe(1);
    expect(res.skipped).toBe(2);
    // Only the one never-priced ISBN book hits the API.
    expect(client.fetchVolumeByIsbn).toHaveBeenCalledTimes(1);
    expect(client.fetchVolumeByIsbn).toHaveBeenCalledWith('9780306406157');
  });
});

describe('PriceTrackingService.fetchItemPrice', () => {
  it('records + returns the latest observation for an enabled org', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'i1', barcode: '9780306406157' }, error: null },
      'item_price_observations.insert': { data: null, error: null },
      'item_price_observations.select': { data: { item_id: 'i1', list_price: 9.99, retail_price: 7.99, currency: 'USD' }, error: null },
    });
    const svc = new PriceTrackingService(makeServiceContext(stub.client, { enabledModules: withPT() }), fakeClient(PRICED));
    const res = await svc.fetchItemPrice('i1');
    expect(res?.retail_price).toBe(7.99);
  });
});
