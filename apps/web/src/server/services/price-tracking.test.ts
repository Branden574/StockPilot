import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { PriceTrackingService, recordBookObservation, refreshBookPricesForOrg } from './price-tracking';
import { GoogleBooksUnavailableError } from '@/server/pricing/google-books-client';

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

  it('stops at maxLookups (the scheduled share of Google calls), apart from the read limit, and never asks again for an item already tried this run', async () => {
    const items = ['i1', 'i2', 'i3', 'i4'].map((id) => ({
      id,
      barcode: '9780306406157',
      last_priced_at: null,
    }));
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: items, error: null },
      'inventory_items.update': { data: null, error: null },
      'item_price_observations.insert': { data: null, error: null },
    });
    const client = fakeClient(PRICED);
    const tried = new Set(['i1']);

    const res = await refreshBookPricesForOrg(stub.client, 'org-1', client, {
      limit: 300,
      maxLookups: 2,
      tried,
    });

    expect(res).toMatchObject({ written: 2, lookups: 2 });
    expect(client.fetchVolumeByIsbn).toHaveBeenCalledTimes(2);
    expect([...tried].sort()).toEqual(['i1', 'i2', 'i3']);
    expect(stub.chainArgsAll.get('inventory_items.select')![0]).toContainEqual([300]);
  });

  it('a lookup that gives no price is counted as a lookup and stamps the book, so it goes to the back of the line', async () => {
    const items = [
      { id: 'unknown', barcode: '9780306406157', last_priced_at: null },
      { id: 'not-isbn', barcode: 'NOTISBN', last_priced_at: null },
    ];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: items, error: null },
      'inventory_items.update': { data: null, error: null },
    });
    const client = fakeClient({ totalItems: 0 }); // Google does not know it

    const res = await refreshBookPricesForOrg(stub.client, 'org-1', client, { limit: 300 });

    expect(res).toMatchObject({ written: 0, lookups: 1, skipped: 2 });
    expect(client.fetchVolumeByIsbn).toHaveBeenCalledTimes(1);
    const stamps = stub.chainArgsAll.get('inventory_items.update') ?? [];
    // Only the book Google was asked about; a barcode that is no ISBN costs
    // no lookup and is left as it was.
    expect(stamps).toHaveLength(1);
    expect(stamps[0]![0]![0]).toEqual({ last_priced_at: expect.any(String) });
    expect(stamps[0]).toContainEqual(['organization_id', 'org-1']);
    expect(stamps[0]).toContainEqual(['id', 'unknown']);
    expect(stub.fromCalls).not.toContain('item_price_observations');
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

describe('when Google does not answer (a rate limit, an error, no reply)', () => {
  /** Answers PRICED for the first `answered` calls, then a 429. */
  const limitedClient = (answered: number) => {
    let calls = 0;
    return {
      fetchVolumeByIsbn: vi.fn(async () => {
        calls += 1;
        if (calls > answered) throw new GoogleBooksUnavailableError(429);
        return PRICED;
      }),
    };
  };

  it('recordBookObservation throws it on, with nothing written and the book not stamped', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.update': { data: null, error: null },
      'item_price_observations.insert': { data: null, error: null },
    });
    await expect(
      recordBookObservation(stub.client, 'org-1', { id: 'i1', barcode: '9780306406157' }, limitedClient(0)),
    ).rejects.toBeInstanceOf(GoogleBooksUnavailableError);
    expect(stub.fromCalls).toEqual([]);
  });

  it('the refresh stops at that book: it and the books after it are left as they were, and the caller is told', async () => {
    const items = ['i1', 'i2', 'i3'].map((id) => ({ id, barcode: '9780306406157', last_priced_at: null }));
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: items, error: null },
      'inventory_items.update': { data: null, error: null },
      'item_price_observations.insert': { data: null, error: null },
    });
    const client = limitedClient(1);
    const tried = new Set<string>();

    const res = await refreshBookPricesForOrg(stub.client, 'org-1', client, { limit: 300, tried });

    expect(res).toMatchObject({ written: 1, lookups: 2, googleUnavailable: true });
    // i3 is never asked about.
    expect(client.fetchVolumeByIsbn).toHaveBeenCalledTimes(2);
    // Only i1, which Google answered, is stamped; i2 (the 429) and i3 keep their place.
    const stamped = (stub.chainArgsAll.get('inventory_items.update') ?? []).map(
      (args) => args.find((a) => a[0] === 'id')?.[1],
    );
    expect(stamped).toEqual(['i1']);
    expect([...tried]).toEqual(['i1']);
  });

  it('the bulk Refresh prices (on demand) returns googleUnavailable to its caller', async () => {
    const items = ['i1', 'i2'].map((id) => ({ id, barcode: '9780306406157', last_priced_at: null }));
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: items, error: null },
      'inventory_items.update': { data: null, error: null },
      'item_price_observations.insert': { data: null, error: null },
    });
    const svc = new PriceTrackingService(
      makeServiceContext(stub.client, { enabledModules: withPT() }),
      limitedClient(0),
    );
    await expect(svc.refreshOrgBookPrices()).resolves.toMatchObject({
      written: 0,
      lookups: 1,
      googleUnavailable: true,
    });
    expect(stub.chainArgsAll.get('inventory_items.update')).toBeUndefined();
  });

  it('a person asking for one price gets the latest observation, and the book is not stamped', async () => {
    const latest = { item_id: 'i1', list_price: 9.99, observed_at: '2026-11-01T00:00:00.000Z' };
    const stub = makeSupabaseStub({
      'inventory_items.select.maybeSingle': { data: { id: 'i1', barcode: '9780306406157' }, error: null },
      'inventory_items.update': { data: null, error: null },
      'item_price_observations.select.maybeSingle': { data: latest, error: null },
    });
    const svc = new PriceTrackingService(
      makeServiceContext(stub.client, { enabledModules: withPT() }),
      limitedClient(0),
    );
    await expect(svc.fetchItemPrice('i1')).resolves.toEqual(latest);
    expect(stub.chainArgsAll.get('inventory_items.update')).toBeUndefined();
  });
});
