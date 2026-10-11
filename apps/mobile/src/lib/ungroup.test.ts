import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, UNGROUP_COPY } from '@stockpilot/core';

// vi.mock below is hoisted above every import by vitest.
import {
  describeUngroupError,
  postUngroup,
  readSkuSiblingCount,
  singleUngroupBody,
} from './ungroup';

const { api, FakeApiError } = vi.hoisted(() => ({
  api: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
      public details?: unknown,
    ) {
      super(message);
    }
  },
}));
vi.mock('./api', () => ({
  api: (...a: unknown[]) => api(...a),
  ApiError: FakeApiError,
}));

/**
 * The phone's "Make this its own item" (Ungroup, migration 0399): ONE record,
 * online only (never queued), over POST /api/v1/items/ungroup, the web's own
 * service. The same key and body on a retry of a busy or lost answer; the
 * words come from core.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = '33333333-3333-4333-8333-333333333333';

beforeEach(() => api.mockReset());

describe('singleUngroupBody', () => {
  it('is core’s body for one record: its SKU as the screen showed it, no anchor', () => {
    expect(
      singleUngroupBody({
        itemId: ITEM,
        sku: 'SP-PAIR',
        organizationId: ORG,
        actorUserId: ME,
        key: KEY,
      }),
    ).toEqual({
      idempotencyKey: KEY,
      organizationId: ORG,
      actorUserId: ME,
      itemIds: [ITEM],
      expectedSkus: { [ITEM]: 'SP-PAIR' },
      anchorItemIds: [],
    });
  });
});

describe('postUngroup', () => {
  it('posts to the bearer route under the item’s organization and ONLY the signed-in account', async () => {
    api.mockResolvedValueOnce({
      organizationId: ORG,
      result: {
        replay: false,
        items: [
          {
            id: ITEM,
            beforeSku: 'SP-PAIR',
            afterSku: 'SP-ABCDE-1234567',
            kept: false,
            anchorItemId: null,
          },
        ],
      },
    });
    const body = singleUngroupBody({
      itemId: ITEM,
      sku: 'SP-PAIR',
      organizationId: ORG,
      actorUserId: ME,
      key: KEY,
    });
    const out = await postUngroup(body);
    expect(api).toHaveBeenCalledWith('/api/v1/items/ungroup', {
      method: 'POST',
      body,
      orgId: ORG,
      asUserId: ME,
    });
    expect(out).toEqual({ replay: false, newSku: 'SP-ABCDE-1234567' });
  });

  it('refuses an answer for another organization or one it cannot read', async () => {
    const body = singleUngroupBody({
      itemId: ITEM,
      sku: 'S',
      organizationId: ORG,
      actorUserId: ME,
      key: KEY,
    });
    api.mockResolvedValueOnce({ organizationId: ME, result: { replay: false, items: [] } });
    await expect(postUngroup(body)).rejects.toThrow();
    api.mockResolvedValueOnce({ nope: true });
    await expect(postUngroup(body)).rejects.toThrow();
  });
});

describe('describeUngroupError', () => {
  it('uses the server’s words for a refusal, and says when the same request may be sent again', () => {
    expect(
      describeUngroupError(
        new FakeApiError(GROUPING_ERROR_WORDS.notShared, 409, 'conflict', { reason: 'not_shared' }),
      ),
    ).toEqual({ message: GROUPING_ERROR_WORDS.notShared, retrySame: false });
    expect(
      describeUngroupError(
        new FakeApiError(GROUPING_ERROR_WORDS.busy, 503, 'conflict', {
          reason: 'busy',
          retryable: true,
        }),
      ),
    ).toEqual({ message: GROUPING_ERROR_WORDS.busy, retrySame: true });
    expect(
      describeUngroupError(new FakeApiError('unauthenticated', 401, 'unauthenticated')),
    ).toEqual({
      message: GROUPING_ERROR_WORDS.unauthenticated,
      retrySame: false,
    });
    expect(
      describeUngroupError(new FakeApiError('rate_limited', 429, 'rate_limited')).retrySame,
    ).toBe(true);
  });

  it('a request that may not have arrived can be sent again with the same key (it replays if it did)', () => {
    const out = describeUngroupError(new TypeError('Network request failed'));
    expect(out.retrySame).toBe(true);
    expect(out.message).not.toMatch(/TypeError|Network request failed/);
  });

  it('never shows a bare code as a sentence', () => {
    expect(
      describeUngroupError(new FakeApiError('internal_error', 500, 'internal_error')).message,
    ).toBe(GROUPING_ERROR_WORDS.internal);
  });
});

describe('readSkuSiblingCount', () => {
  it('counts the OTHER live records with the same raw SKU the member can read (head count)', async () => {
    const filters: [string, string, unknown][] = [];
    let selectArgs: unknown[] = [];
    const client = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = (...a: unknown[]) => ((selectArgs = a), q);
        for (const op of ['eq', 'is', 'neq'])
          q[op] = (c: string, v: unknown) => (filters.push([op, c, v]), q);
        (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
          res({ count: 1, error: null });
        return q;
      },
    };
    expect(await readSkuSiblingCount(client as never, ORG, ITEM, 'SP-PAIR')).toBe(1);
    expect(selectArgs).toEqual(['id', { count: 'exact', head: true }]);
    expect(filters).toEqual([
      ['eq', 'organization_id', ORG],
      ['eq', 'sku', 'SP-PAIR'],
      ['is', 'deleted_at', null],
      ['neq', 'id', ITEM],
    ]);
    expect(await readSkuSiblingCount(client as never, ORG, ITEM, '  ')).toBe(0);
  });
});

describe('the item screen’s wiring (source pins: the screen is not rendered under vitest)', () => {
  const src = readFileSync(resolve(__dirname, '../../app/item/[id].tsx'), 'utf8');
  it('reads the sibling count with the item and shows core’s note and button', () => {
    expect(src).toMatch(/readSkuSiblingCount\(/);
    expect(src).toMatch(/sharedSkuNoteCopy\(/);
    expect(src).toContain('UNGROUP_COPY.makeOwnItem');
  });
  it('is online only: refuses offline with core’s words and never queues it', () => {
    expect(src).toContain('UNGROUP_COPY.offline');
    expect(src).not.toMatch(/enqueue\([^)]*ungroup/i);
  });
  it('is offered only to a member who holds items:update, and never for a kit or a family member', () => {
    expect(src).toMatch(/canMakeOwnItem\s*=/);
    expect(src).toMatch(/'items:update'/);
    expect(src).toMatch(/is_bundle/);
    expect(src).toMatch(/group_id/);
  });
  it('keeps one key per attempt and sends the same body again on a retry', () => {
    expect(src).toMatch(/randomRequestUuid\(\)/);
    expect(src).toMatch(/retrySame/);
  });
  it('the screen still words this as a phone note, not the old "edited on web" sentence alone', () => {
    expect(UNGROUP_COPY.makeOwnItem).toBe('Make this its own item');
  });
});
