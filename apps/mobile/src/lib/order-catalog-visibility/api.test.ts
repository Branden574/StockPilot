import { describe, expect, it, vi } from 'vitest';

import {
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_INTERNAL_COPY,
  ORDER_ITEMS_INVALID_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_MODULE_DISABLED_COPY,
  ORDER_PHONE_AAL2_COPY,
  parseOrderCatalogManageQuery,
} from '@stockpilot/core';

import {
  ManageAnswerForAnotherOrganization,
  ManageShapeError,
  ORDER_CATALOG_MANAGE_PATH,
  createOrderCatalogManageApi,
  manageFailure,
  manageFamilyPath,
  manageListPath,
  parseFamilyAnswer,
  parseManageListAnswer,
  parseWriteAnswer,
  type ManageApiOptions,
} from './api';
import { ORDER_ITEMS_PHONE_RATE_LIMITED_COPY, ORDER_ITEMS_PHONE_SIGN_IN_COPY } from './words';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FAM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OP = '55555555-5555-4555-8555-555555555555';
const SCOPE = { orgId: ORG, userId: USER };

const ROW = {
  id: A,
  name: 'New Hire Shirt',
  sku: 'NHS-XS',
  identifier: '0123456789012',
  itemType: 'item',
  sizeOrEdition: 'XS',
  warehouseId: WH,
  warehouseName: 'North',
  categoryName: 'Apparel',
  familyId: FAM,
  familyName: 'New Hire Shirt',
  expected: false,
  visible: false,
  hiddenSince: '2026-10-26T12:00:00.000Z',
  thumbUrl: 'https://storage.example.org/thumb.jpg?token=x',
};
const LIST = {
  organizationId: ORG,
  viewer: { canManage: true },
  page: 2,
  pageSize: 25,
  total: 26,
  rows: [ROW],
};

/** An api() failure as ApiError carries it. */
function apiError(status: number, code?: string, details?: unknown): Error {
  return Object.assign(new Error('server words'), { name: 'ApiError', status, code, details });
}

describe('paths', () => {
  it('the list path carries only the filters that differ from the defaults (core query string)', () => {
    expect(manageListPath(parseOrderCatalogManageQuery({}))).toBe(ORDER_CATALOG_MANAGE_PATH);
    expect(
      manageListPath(parseOrderCatalogManageQuery({ q: ' shirt ', visibility: 'hidden', type: 'books', page: '3' })),
    ).toBe(`${ORDER_CATALOG_MANAGE_PATH}?q=shirt&visibility=hidden&type=books&page=3`);
    expect(manageListPath(parseOrderCatalogManageQuery({ warehouseId: WH, categoryId: 'nope' }))).toBe(
      `${ORDER_CATALOG_MANAGE_PATH}?warehouseId=${WH}`,
    );
  });

  it('the family path asks only for a uuid, lower-cased; anything else is not asked', () => {
    expect(manageFamilyPath(FAM.toUpperCase())).toBe(`${ORDER_CATALOG_MANAGE_PATH}/family/${FAM}`);
    expect(manageFamilyPath('../catalog')).toBeNull();
    expect(manageFamilyPath('')).toBeNull();
  });
});

describe('reading the list answer', () => {
  it('reads every documented field, field by field (extra keys ignored)', () => {
    const a = parseManageListAnswer({ ...LIST, rows: [{ ...ROW, unitCost: 9, quantityOnHand: 4 }], later: 1 });
    expect(a).toEqual({ ...LIST, rows: [ROW] });
    expect(Object.keys(a.rows[0]!)).not.toContain('unitCost');
    expect(Object.keys(a.rows[0]!)).not.toContain('quantityOnHand');
  });

  it('keeps only an http(s) picture; anything else is no picture', () => {
    const pic = (thumbUrl: unknown) => parseManageListAnswer({ ...LIST, rows: [{ ...ROW, thumbUrl }] }).rows[0]!.thumbUrl;
    expect(pic('http://covers.example.org/a.jpg')).toBe('http://covers.example.org/a.jpg');
    expect(pic('javascript:alert(1)')).toBeNull();
    expect(pic('file:///etc/passwd')).toBeNull();
    expect(pic(null)).toBeNull();
    expect(pic(undefined)).toBeNull();
  });

  it('a book row reads as a book; nullable fields stay null', () => {
    const r = parseManageListAnswer({
      ...LIST,
      rows: [{ ...ROW, itemType: 'book', identifier: null, sizeOrEdition: null, familyId: null, familyName: null, categoryName: null, warehouseName: null, hiddenSince: null, visible: true }],
    }).rows[0]!;
    expect(r).toMatchObject({ itemType: 'book', identifier: null, familyId: null, hiddenSince: null, visible: true });
  });

  it.each([
    ['no organization', { ...LIST, organizationId: undefined }],
    ['a viewer who cannot manage', { ...LIST, viewer: { canManage: false } }],
    ['no viewer', { ...LIST, viewer: undefined }],
    ['rows not a list', { ...LIST, rows: {} }],
    ['a total that is not a whole number', { ...LIST, total: 1.5 }],
    ['a page below 1', { ...LIST, page: 0 }],
    ['a row with no id', { ...LIST, rows: [{ ...ROW, id: undefined }] }],
    ['a row of an unknown type', { ...LIST, rows: [{ ...ROW, itemType: 'kit' }] }],
    ['a row whose state is not true or false', { ...LIST, rows: [{ ...ROW, visible: 'yes' }] }],
    ['a row with no warehouse', { ...LIST, rows: [{ ...ROW, warehouseId: null }] }],
  ])('refuses the whole page, never a silent gap: %s', (_l, raw) => {
    expect(() => parseManageListAnswer(raw)).toThrow(ManageShapeError);
  });
});

describe('reading the family and write answers', () => {
  it('a family answer: its rows, its name and whether it was cut', () => {
    expect(parseFamilyAnswer({ organizationId: ORG, familyId: FAM, familyName: 'Shirt', rows: [ROW], truncated: true })).toEqual({
      organizationId: ORG,
      familyId: FAM,
      familyName: 'Shirt',
      rows: [ROW],
      truncated: true,
    });
    expect(parseFamilyAnswer({ organizationId: ORG, familyId: FAM, familyName: null, rows: [] }).truncated).toBe(false);
    expect(() => parseFamilyAnswer({ organizationId: ORG, familyId: FAM, rows: 'x' })).toThrow(ManageShapeError);
  });

  it('a write answer: two lists of ids, lower-cased', () => {
    expect(
      parseWriteAnswer({ organizationId: ORG, operationId: OP, visible: false, changed: [A.toUpperCase()], unchanged: [B] }),
    ).toEqual({ organizationId: ORG, operationId: OP, visible: false, changed: [A], unchanged: [B] });
    expect(() => parseWriteAnswer({ organizationId: ORG, operationId: OP, visible: 'no', changed: [], unchanged: [] })).toThrow(ManageShapeError);
    expect(() => parseWriteAnswer({ organizationId: ORG, operationId: OP, visible: true, changed: [1], unchanged: [] })).toThrow(ManageShapeError);
  });
});

describe('the calls', () => {
  function harness(answer: unknown) {
    const calls: [string, ManageApiOptions][] = [];
    const call = vi.fn(async (p: string, o: ManageApiOptions) => {
      calls.push([p, o]);
      return answer;
    });
    return { api: createOrderCatalogManageApi(call), calls };
  }

  it('every call names the organization and the account it is for', async () => {
    const h = harness(LIST);
    await h.api.list(SCOPE, parseOrderCatalogManageQuery({ page: '2' }));
    expect(h.calls[0]).toEqual([`${ORDER_CATALOG_MANAGE_PATH}?page=2`, { orgId: ORG, asUserId: USER, signal: undefined }]);
  });

  it('an answer for another organization is dropped', async () => {
    await expect(harness({ ...LIST, organizationId: OTHER }).api.list(SCOPE, parseOrderCatalogManageQuery({}))).rejects.toBeInstanceOf(
      ManageAnswerForAnotherOrganization,
    );
    await expect(
      harness({ organizationId: OTHER, familyId: FAM, familyName: null, rows: [] }).api.family(SCOPE, FAM),
    ).rejects.toBeInstanceOf(ManageAnswerForAnotherOrganization);
    await expect(
      harness({ organizationId: OTHER, operationId: OP, visible: false, changed: [A], unchanged: [] }).api.write(SCOPE, {
        itemIds: [A],
        visible: false,
        operationId: OP,
      }),
    ).rejects.toBeInstanceOf(ManageAnswerForAnotherOrganization);
  });

  it('a family answer for another family is refused; a malformed id is never asked', async () => {
    await expect(
      harness({ organizationId: ORG, familyId: OTHER, familyName: null, rows: [] }).api.family(SCOPE, FAM),
    ).rejects.toBeInstanceOf(ManageShapeError);
    const h = harness({});
    await expect(h.api.family(SCOPE, 'not-a-family')).rejects.toBeInstanceOf(ManageShapeError);
    expect(h.calls).toHaveLength(0);
  });

  it('a write POSTs exactly the body, and its answer must account for exactly the ids sent', async () => {
    const body = { itemIds: [A, B], visible: false, operationId: OP };
    const ok = harness({ organizationId: ORG, operationId: OP, visible: false, changed: [A], unchanged: [B] });
    await expect(ok.api.write(SCOPE, body)).resolves.toMatchObject({ changed: [A], unchanged: [B] });
    expect(ok.calls[0]).toEqual([ORDER_CATALOG_MANAGE_PATH, { method: 'POST', body, orgId: ORG, asUserId: USER }]);

    // Another operation, another state, an id never sent, an id missing,
    // an id in both lists: none of them is claimed as saved.
    for (const answer of [
      { organizationId: ORG, operationId: OTHER, visible: false, changed: [A], unchanged: [B] },
      { organizationId: ORG, operationId: OP, visible: true, changed: [A], unchanged: [B] },
      { organizationId: ORG, operationId: OP, visible: false, changed: [A, OTHER], unchanged: [B] },
      { organizationId: ORG, operationId: OP, visible: false, changed: [A], unchanged: [] },
      { organizationId: ORG, operationId: OP, visible: false, changed: [A, B], unchanged: [B] },
    ]) {
      await expect(harness(answer).api.write(SCOPE, body)).rejects.toBeInstanceOf(ManageShapeError);
    }
  });
});

describe('what a failure means (by status and details.reason, never the message)', () => {
  it.each([
    ['forbidden', apiError(403, 'forbidden', { reason: 'forbidden' }), 'forbidden', true, ORDER_ITEMS_FORBIDDEN_COPY],
    ['switch off', apiError(403, 'forbidden', { reason: 'feature_disabled' }), 'feature_disabled', true, ORDER_ITEMS_FEATURE_DISABLED_COPY],
    ['module off', apiError(403, 'module_disabled', { reason: 'module_disabled' }), 'module_disabled', true, ORDER_ITEMS_MODULE_DISABLED_COPY],
    ['a 403 with no reason', apiError(403), 'forbidden', true, ORDER_ITEMS_FORBIDDEN_COPY],
    ['MFA not set up', apiError(403, 'forbidden', { reason: 'mfa_required' }), 'mfa_required', false, ORDER_ITEMS_MFA_REQUIRED_COPY],
    ['step-up', apiError(403, 'forbidden', { reason: 'aal2_required' }), 'aal2_required', false, ORDER_PHONE_AAL2_COPY],
    ['invalid', apiError(400, 'validation_error', { reason: 'invalid', field: 'itemIds' }), 'invalid', false, ORDER_ITEMS_INVALID_COPY],
    ['signed out', apiError(401, 'unauthenticated', { reason: 'unauthenticated' }), 'unauthenticated', false, ORDER_ITEMS_PHONE_SIGN_IN_COPY],
    ['rate limited', apiError(429, 'rate_limited', { reason: 'rate_limited' }), 'rate_limited', false, ORDER_ITEMS_PHONE_RATE_LIMITED_COPY],
    ['an old server with no such route', apiError(404), 'feature_disabled', true, ORDER_ITEMS_FEATURE_DISABLED_COPY],
  ])('%s', (_l, e, reason, final, message) => {
    for (const kind of ['read', 'write'] as const) {
      expect(manageFailure(e, kind)).toMatchObject({ reason, final, message });
    }
  });

  it('items unavailable: nothing changed; only the ids the caller sent are named, lower-cased', () => {
    const f = manageFailure(apiError(409, 'conflict', { reason: 'items_unavailable', itemIds: [A.toUpperCase(), 'junk', 7] }), 'write');
    expect(f).toMatchObject({ reason: 'items_unavailable', final: false, message: ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY, retrySame: false });
    expect(f.itemIds).toEqual([A]);
  });

  it('busy, a rate limit, a step-up and no answer may resend the SAME body; the rest may not', () => {
    expect(manageFailure(apiError(409, 'conflict', { reason: 'busy', retryable: true }), 'write')).toMatchObject({
      reason: 'busy',
      message: ORDER_ITEMS_BUSY_COPY,
      retrySame: true,
    });
    expect(manageFailure(apiError(429, 'rate_limited', { reason: 'rate_limited' }), 'write').retrySame).toBe(true);
    expect(manageFailure(apiError(403, 'forbidden', { reason: 'aal2_required' }), 'write').retrySame).toBe(true);
    expect(manageFailure(new TypeError('Network request failed'), 'write')).toMatchObject({
      reason: 'no_answer',
      message: ORDER_ITEMS_INTERNAL_COPY,
      retrySame: true,
    });
    expect(manageFailure(apiError(403, 'forbidden', { reason: 'forbidden' }), 'write').retrySame).toBe(false);
    expect(manageFailure(apiError(400, 'validation_error', { reason: 'invalid' }), 'write').retrySame).toBe(false);
  });

  it('a fault never shows the server or network text: reads say the list failed, writes that nothing is claimed', () => {
    expect(manageFailure(apiError(500, 'internal_error', { reason: 'failed' }), 'read')).toMatchObject({
      reason: 'internal',
      message: ORDER_ITEMS_LOAD_FAILED_COPY,
    });
    expect(manageFailure(apiError(500, 'internal_error', { reason: 'failed' }), 'write')).toMatchObject({
      reason: 'internal',
      message: ORDER_ITEMS_INTERNAL_COPY,
    });
    expect(manageFailure(new TypeError('fetch failed: Could not connect'), 'read')).toMatchObject({
      reason: 'no_answer',
      message: ORDER_ITEMS_LOAD_FAILED_COPY,
    });
    expect(manageFailure(new ManageShapeError('rows'), 'read')).toMatchObject({ reason: 'internal', message: ORDER_ITEMS_LOAD_FAILED_COPY });
    expect(manageFailure(new ManageShapeError('rows'), 'write')).toMatchObject({ reason: 'internal', message: ORDER_ITEMS_INTERNAL_COPY });
  });

  it('an answer for another organization, or a request the account change stopped, is dropped without words', () => {
    expect(manageFailure(new ManageAnswerForAnotherOrganization(), 'read')).toMatchObject({ reason: 'other_organization', message: '' });
    const stopped = Object.assign(new Error('x'), { name: 'OutboxSessionChangedError' });
    expect(manageFailure(stopped, 'write')).toMatchObject({ reason: 'other_organization', message: '' });
  });
});
