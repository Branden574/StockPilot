import { describe, expect, it, vi } from 'vitest';

import {
  ORDER_CATALOG_VISIBILITY_MAX_ITEMS,
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_OFFLINE_COPY,
  ORDER_ITEMS_SELECTION_CAP_COPY,
} from '@stockpilot/core';

import { createOrderCatalogManageApi, type ManageApiOptions } from './api';
import { keyedVisibilityBody, sendVisibility, visibilityDraft, visibilityWriteBlockedBy } from './write';
import { ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY } from './words';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const K1 = '55555555-5555-4555-8555-555555555555';
const K2 = '77777777-7777-4777-8777-777777777777';
const SCOPE = { orgId: ORG, userId: USER };

describe('the body of a Show or Hide', () => {
  it('the draft is the explicit ids, lower-cased, once each, sorted', () => {
    expect(visibilityDraft([B, A.toUpperCase(), B], false)).toEqual({ itemIds: [A, B], visible: false });
  });

  it('one operationId per body, kept for its retries; any change to the draft is a new operation', () => {
    const mint = vi.fn().mockReturnValueOnce(K1).mockReturnValueOnce(K2);
    const first = keyedVisibilityBody(null, visibilityDraft([A, B], false), mint);
    expect(first.body).toEqual({ itemIds: [A, B], visible: false, operationId: K1 });
    // The same draft (in any order): the same key, nothing minted.
    expect(keyedVisibilityBody(first, visibilityDraft([B, A], false), mint)).toBe(first);
    expect(mint).toHaveBeenCalledTimes(1);
    // Another state or other ids: a new key.
    expect(keyedVisibilityBody(first, visibilityDraft([A, B], true), mint).body.operationId).toBe(K2);
  });

  it('never sends offline (a change is never queued), past the cap, with nothing selected, or once locked', () => {
    expect(visibilityWriteBlockedBy({ offline: true, count: 2, locked: null })).toBe(ORDER_ITEMS_OFFLINE_COPY);
    expect(visibilityWriteBlockedBy({ offline: false, count: ORDER_CATALOG_VISIBILITY_MAX_ITEMS + 1, locked: null })).toBe(
      ORDER_ITEMS_SELECTION_CAP_COPY,
    );
    expect(visibilityWriteBlockedBy({ offline: false, count: 0, locked: null })).toBe(ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY);
    expect(visibilityWriteBlockedBy({ offline: false, count: 2, locked: ORDER_ITEMS_FORBIDDEN_COPY })).toBe(ORDER_ITEMS_FORBIDDEN_COPY);
    expect(visibilityWriteBlockedBy({ offline: false, count: ORDER_CATALOG_VISIBILITY_MAX_ITEMS, locked: null })).toBeNull();
  });
});

describe('sending', () => {
  function apiAnswering(fn: (p: string, o: ManageApiOptions) => unknown) {
    const call = vi.fn(async (p: string, o: ManageApiOptions) => fn(p, o));
    return { api: createOrderCatalogManageApi(call), call };
  }
  const pending = keyedVisibilityBody(null, visibilityDraft([A, B], false), () => K1);

  it('sends exactly the pending body once and hands back the checked answer', async () => {
    const h = apiAnswering(() => ({ organizationId: ORG, operationId: K1, visible: false, changed: [A], unchanged: [B] }));
    await expect(sendVisibility(h.api, SCOPE, pending)).resolves.toEqual({
      ok: true,
      answer: { organizationId: ORG, operationId: K1, visible: false, changed: [A], unchanged: [B] },
    });
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: pending.body, orgId: ORG, asUserId: USER });
  });

  it('a refusal never throws: it is read into words and whether the same body may go again', async () => {
    const h = apiAnswering(() => {
      throw Object.assign(new Error('x'), { status: 409, code: 'conflict', details: { reason: 'busy' } });
    });
    await expect(sendVisibility(h.api, SCOPE, pending)).resolves.toMatchObject({
      ok: false,
      failure: { reason: 'busy', message: ORDER_ITEMS_BUSY_COPY, retrySame: true },
    });
  });
});
