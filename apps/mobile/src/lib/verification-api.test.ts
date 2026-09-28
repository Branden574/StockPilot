import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  RECOUNT_OFFLINE_COPY,
  VERIFICATION_NEVER_COUNTED_COPY,
  VERIFICATION_SESSION_ENDED_COPY,
  VERIFICATION_UNAVAILABLE_COPY,
  locationRowVerificationCopy,
  verificationIssueChipCopy,
  verificationRefusalCopy,
  verificationSummaryCopy,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';
import * as verification from './verification-api';
import {
  recountGatherFailureCopy,
  LOCATION_HOLDINGS_TRUNCATED_COPY,
  RECOUNT_GATHER_CHANGED_COPY,
  canOpenCountScreen,
  RECOUNT_GATHER_MAX_PAGES,
  RECOUNT_GATHER_TOO_MANY_PAGES_COPY,
  VERIFICATION_OFFLINE_COPY,
  VerificationResponseError,
  describeVerificationError,
  gatherRecountItemIds,
  getItemVerification,
  getLocationVerification,
  locationKindLabel,
  locationRecountState,
  locationRowAccessibilityLabel,
  locationRowQuantityCopy,
  parseItemVerification,
  parseLocationVerification,
  verificationCheckedAtCopy,
  verificationFailure,
  verificationKey,
  verificationView,
  type MobileItemVerification,
  type StoredVerification,
} from './verification-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under node (same idiom as
// exceptions-api.test.ts).
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
});

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const ITEM = '22222222-2222-4222-8222-222222222222';
const ITEM_2 = '22222222-2222-4222-8222-000000000002';
const LOC = '33333333-3333-4333-8333-333333333333';
const CC = '44444444-4444-4444-8444-444444444444';
const TZ = 'America/Los_Angeles';

function lastCountJson(o: Record<string, unknown> = {}) {
  return {
    cycleCountId: CC,
    countNumber: 1,
    completedAt: '2026-09-12T17:00:00Z',
    countedAt: '2026-09-12T16:40:00Z',
    capturedAt: null,
    baselineAt: '2026-09-12T16:40:00Z',
    expectedQuantity: 50,
    expectedAtStart: 50,
    countedQuantity: 48,
    countedLocationId: LOC,
    countedLocation: { name: 'QA-1', kind: 'rack', type: 'shelf', archived: false },
    aiAssisted: false,
    countedBy: { id: 'u1', label: 'Ana' },
    postedBy: { id: 'u2', label: 'Ben' },
    ...o,
  };
}

function summaryJson(o: Record<string, unknown> = {}, itemId = ITEM) {
  return {
    itemId,
    item: {
      status: 'active',
      isRental: false,
      isBundle: false,
      deleted: false,
      countable: true,
      quantityOnHand: 48,
    },
    lastCount: lastCountJson(),
    movementsSince: 0,
    outsideLedgerSince: 0,
    openCount: null,
    ...o,
  };
}

function itemBody(o: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    itemId: ITEM,
    summary: summaryJson(),
    openIssues: [],
    openIssuesTruncated: false,
    checkedAt: '2026-09-27T14:00:00Z',
    canCount: true,
    countUnavailableReason: null,
    timeZone: TZ,
    ...o,
  };
}

function issueJson(o: Record<string, unknown> = {}) {
  return {
    id: 'occ-1',
    number: 42,
    reference: 'EX-000042',
    rule: 'count_variance',
    itemId: ITEM,
    locationId: null,
    ...o,
  };
}

function rowJson(itemId: string, o: Record<string, unknown> = {}) {
  return {
    itemId,
    name: `Item ${itemId.slice(-4)}`,
    sku: 'SKU-1',
    quantity: 12,
    summary: summaryJson({}, itemId),
    issues: [],
    ...o,
  };
}

function totalsJson(o: Record<string, unknown> = {}) {
  return {
    items: 1,
    quantity: 12,
    countedHere: 1,
    countedItemTotal: 0,
    notCounted: 0,
    unavailable: 0,
    hiddenItems: 0,
    hiddenQuantity: 0,
    countable: 1,
    ...o,
  };
}

function locationBody(o: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    location: {
      id: LOC,
      name: 'QA-1',
      kind: 'rack',
      type: null,
      warehouseId: 'wh-1',
      warehouseName: 'Main',
      archived: false,
    },
    holdingsVisible: true,
    openIssues: [],
    openIssuesTruncated: false,
    rows: [rowJson(ITEM)],
    page: 1,
    pageSize: 50,
    pageCount: 1,
    totalRows: 1,
    totals: totalsJson(),
    truncated: false,
    checkedAt: '2026-09-27T14:00:00Z',
    canRecount: true,
    recountUnavailableReason: null,
    recountProblem: null,
    timeZone: TZ,
    ...o,
  };
}

/** An ApiError-shaped rejection (the real class lives in the mocked ./api). */
function apiError(status: number, message: string, code?: string, details?: unknown) {
  return Object.assign(new Error(message), { status, code, details });
}

// ═══════════════════════════════════════════════════════════════════════════
// The item answer
// ═══════════════════════════════════════════════════════════════════════════

describe('parseItemVerification', () => {
  // F1-5 (the experience review): the item card's chips left out the
  // escalation every other surface shows. Mutation caught: the escalation
  // dropped by the parse (the chip then says nothing about it).
  it('an escalated issue keeps its request handle and cancelled state, so the chip says "Escalated: MR-..."', () => {
    const v = parseItemVerification(
      itemBody({
        openIssues: [
          issueJson({ escalation: { reference: 'MR-2026-000014', cancelled: false } }),
          issueJson({ id: 'occ-2', number: 43, reference: 'EX-000043', escalation: { reference: 'MR-2026-000009', cancelled: true } }),
          issueJson({ id: 'occ-3', number: 44, reference: 'EX-000044', escalation: { reference: 'MR-2026-000010', cancelled: 'yes' } }),
          issueJson({ id: 'occ-4', number: 45, reference: 'EX-000045', escalation: 'MR-2026-000011' }),
        ],
      }),
    );
    expect(v.openIssues.map((i) => i.escalation)).toEqual([
      { reference: 'MR-2026-000014', cancelled: false },
      { reference: 'MR-2026-000009', cancelled: true },
      // Not a real boolean: "cancelled" is not known, never guessed.
      { reference: 'MR-2026-000010', cancelled: null },
      null,
    ]);
    expect(v.openIssues.map((i) => verificationIssueChipCopy(i))).toEqual([
      'EX-000042 · Count did not match the stock on record · Escalated: MR-2026-000014',
      'EX-000043 · Count did not match the stock on record · Escalated: MR-2026-000009 (request cancelled)',
      'EX-000044 · Count did not match the stock on record · Escalated: MR-2026-000010',
      'EX-000045 · Count did not match the stock on record',
    ]);
  });

  it('reads the whole answer, and core words it as the web card does', () => {
    const v = parseItemVerification(itemBody({ openIssues: [issueJson()] }));
    expect(v.organizationId).toBe(ORG);
    expect(v.summary.lastCount?.countedQuantity).toBe(48);
    expect(v.openIssues).toEqual([
      {
        id: 'occ-1',
        number: 42,
        reference: 'EX-000042',
        rule: 'count_variance',
        itemId: ITEM,
        locationId: null,
        escalation: null,
      },
    ]);
    const copy = verificationSummaryCopy(v.summary, { timeZone: v.timeZone, canCount: v.canCount });
    expect(copy.headline).toBe('Last physical count: Sep 12, 2026 · CC-000001');
    expect(copy.result).toContain('50 to 48');
    expect(copy.movementsSince).toBe('0 recorded stock movements since');
  });

  it('a never-counted item is a stated answer: "No physical count on record."', () => {
    const v = parseItemVerification(
      itemBody({
        summary: summaryJson({ lastCount: null, movementsSince: null, outsideLedgerSince: null }),
      }),
    );
    expect(v.summary.lastCount).toBeNull();
    expect(verificationSummaryCopy(v.summary).headline).toBe(VERIFICATION_NEVER_COUNTED_COPY);
  });

  // Mutation caught: falling back to "never counted" (lastCount null) when the
  // summary cannot be read. A malformed count must never read as no count.
  it.each([
    ['no summary', { summary: null }],
    ['a summary without lastCount', { summary: { ...summaryJson(), lastCount: undefined } }],
    ['a garbled lastCount', { summary: summaryJson({ lastCount: { cycleCountId: 7 } }) }],
    [
      'a count without a counted number',
      { summary: summaryJson({ lastCount: lastCountJson({ countedQuantity: null }) }) },
    ],
    ['a summary for another item', { summary: summaryJson({}, ITEM_2) }],
    ['no item id', { itemId: undefined }],
    ['no organization', { organizationId: undefined }],
  ])('%s is a failed read, never "never counted"', (_label, patch) => {
    expect(() => parseItemVerification(itemBody(patch))).toThrow(VerificationResponseError);
  });

  // Mutation caught: `Array.isArray(v) ? v.map(...) : []`, which turned a
  // missing list into "no open exceptions".
  it.each([
    ['missing', undefined],
    ['not a list', { id: 'occ-1' }],
    ['an issue without an id', [issueJson({ id: undefined })]],
    ['an issue without a rule', [issueJson({ rule: 5 })]],
  ])('open issues %s is a failure, never "no open exceptions"', (_label, openIssues) => {
    expect(() => parseItemVerification(itemBody({ openIssues }))).toThrow(
      VerificationResponseError,
    );
  });

  it('checkedAt: null is "the first check has not run"; missing or garbled is a failure', () => {
    expect(parseItemVerification(itemBody({ checkedAt: null })).checkedAt).toBeNull();
    expect(() => parseItemVerification(itemBody({ checkedAt: undefined }))).toThrow(
      VerificationResponseError,
    );
    expect(() => parseItemVerification(itemBody({ checkedAt: 'soon' }))).toThrow(
      VerificationResponseError,
    );
  });

  it('offers a count only on an explicit yes from the server', () => {
    expect(parseItemVerification(itemBody({ canCount: 'true' })).canCount).toBe(false);
    expect(parseItemVerification(itemBody({ canCount: undefined })).canCount).toBe(false);
    expect(parseItemVerification(itemBody({ canCount: true })).canCount).toBe(true);
  });

  it('keeps a known unavailable reason and drops an unknown one', () => {
    expect(
      parseItemVerification(itemBody({ countUnavailableReason: 'module_disabled' }))
        .countUnavailableReason,
    ).toBe('module_disabled');
    expect(
      parseItemVerification(itemBody({ countUnavailableReason: 'later' })).countUnavailableReason,
    ).toBeNull();
  });

  it('compares ids as uuids (the database answers in lower case)', () => {
    const upper = ITEM.toUpperCase();
    expect(parseItemVerification(itemBody({ itemId: upper })).itemId).toBe(upper);
  });
});

describe('getItemVerification', () => {
  it('reads the Bearer route for the workspace the screen shows', async () => {
    apiMock.api.mockResolvedValueOnce(itemBody());
    const v = await getItemVerification(ITEM, { orgId: ORG });
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/items/${ITEM}/verification`, {
      orgId: ORG,
      signal: undefined,
    });
    expect(v.itemId).toBe(ITEM);
  });

  // Mutation caught: dropping the organization check, which painted another
  // workspace's count after a switch made while the request was out.
  it('refuses an answer for another workspace', async () => {
    apiMock.api.mockResolvedValueOnce(itemBody({ organizationId: OTHER_ORG }));
    await expect(getItemVerification(ITEM, { orgId: ORG })).rejects.toMatchObject({
      problem: 'workspace',
    });
  });

  it('refuses an answer for another item', async () => {
    apiMock.api.mockResolvedValueOnce(
      itemBody({ itemId: ITEM_2, summary: summaryJson({}, ITEM_2) }),
    );
    await expect(getItemVerification(ITEM, { orgId: ORG })).rejects.toBeInstanceOf(
      VerificationResponseError,
    );
  });

  it('never sends a malformed id', async () => {
    await expect(getItemVerification('not-an-id', { orgId: ORG })).rejects.toMatchObject({
      problem: 'invalid_id',
    });
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  // Mutation caught: a catch that resolves an empty summary.
  it('a failed request rejects; it never resolves to an answer', async () => {
    apiMock.api.mockRejectedValueOnce(
      apiError(500, VERIFICATION_UNAVAILABLE_COPY, 'internal_error'),
    );
    await expect(getItemVerification(ITEM, { orgId: ORG })).rejects.toThrow(
      VERIFICATION_UNAVAILABLE_COPY,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The location answer
// ═══════════════════════════════════════════════════════════════════════════

describe('parseLocationVerification', () => {
  it('reads the location, the page and the totals across every row', () => {
    const v = parseLocationVerification(locationBody());
    expect(v.location).toEqual({
      id: LOC,
      name: 'QA-1',
      kind: 'rack',
      type: null,
      warehouseId: 'wh-1',
      warehouseName: 'Main',
      archived: false,
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]!.summary?.lastCount?.countedLocationId).toBe(LOC);
    expect(v.totals).toEqual(totalsJson());
    expect([v.page, v.pageSize, v.pageCount, v.totalRows]).toEqual([1, 50, 1, 1]);
    const copy = locationRowVerificationCopy(v.rows[0]!.summary, LOC, {
      timeZone: v.timeZone,
      locationKind: 'rack',
    });
    expect(copy.count).toBe('Counted Sep 12, 2026, while this was its only shelf location');
  });

  // Mutation caught: defaulting holdingsVisible (false claims "not in your
  // warehouses", true an empty location).
  it('holdingsVisible must be said: a missing one is a failure', () => {
    expect(() => parseLocationVerification(locationBody({ holdingsVisible: undefined }))).toThrow(
      VerificationResponseError,
    );
  });

  it('out of scope: no totals, whatever else was sent', () => {
    const v = parseLocationVerification(
      locationBody({ holdingsVisible: false, rows: [], totals: totalsJson() }),
    );
    expect(v.holdingsVisible).toBe(false);
    expect(v.totals).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['without countable', { ...totalsJson(), countable: undefined }],
    ['with a negative quantity', totalsJson({ quantity: -1 })],
  ])('visible holdings with totals %s is a failure', (_label, totals) => {
    expect(() => parseLocationVerification(locationBody({ totals }))).toThrow(
      VerificationResponseError,
    );
  });

  it('a row the server could not summarise stays a row, read as unavailable (never "Not counted")', () => {
    const v = parseLocationVerification(locationBody({ rows: [rowJson(ITEM, { summary: null })] }));
    expect(v.rows[0]!.summary).toBeNull();
    expect(locationRowVerificationCopy(v.rows[0]!.summary, LOC).count).toBe(
      VERIFICATION_UNAVAILABLE_COPY,
    );
  });

  // Mutation caught: one unreadable row failing the whole page, or reading as
  // never counted.
  it('a row summary this build cannot read is that row unavailable, not the page', () => {
    const v = parseLocationVerification(
      locationBody({
        rows: [
          rowJson(ITEM, { summary: { itemId: ITEM } }),
          rowJson(ITEM_2, { summary: summaryJson({}, ITEM) }),
        ],
      }),
    );
    expect(v.rows.map((r) => r.summary)).toEqual([null, null]);
  });

  it("reads the server's recount list; none sent is null (the phone then gathers the pages)", () => {
    expect(
      parseLocationVerification(locationBody({ recountItemIds: [ITEM, ITEM_2] })).recountItemIds,
    ).toEqual([ITEM, ITEM_2]);
    expect(parseLocationVerification(locationBody({ recountItemIds: [] })).recountItemIds).toEqual(
      [],
    );
    expect(parseLocationVerification(locationBody()).recountItemIds).toBeNull();
    expect(() => parseLocationVerification(locationBody({ recountItemIds: [ITEM, 7] }))).toThrow(
      VerificationResponseError,
    );
    expect(() => parseLocationVerification(locationBody({ recountItemIds: ITEM }))).toThrow(
      VerificationResponseError,
    );
  });

  it.each([
    ['no rows list', { rows: undefined }],
    ['a row without a name', { rows: [rowJson(ITEM, { name: null })] }],
    ['a row without a quantity', { rows: [rowJson(ITEM, { quantity: undefined })] }],
    ['a row without its issues', { rows: [rowJson(ITEM, { issues: undefined })] }],
    ['a page past the page count', { page: 3, pageCount: 2 }],
    ['page 0', { page: 0 }],
    ['no location name', { location: { id: LOC } }],
    ['no open issues list', { openIssues: undefined }],
  ])('%s is a failure', (_label, patch) => {
    expect(() => parseLocationVerification(locationBody(patch))).toThrow(VerificationResponseError);
  });
});

describe('getLocationVerification', () => {
  it('page 1 is the bare path; later pages ask for the page', async () => {
    apiMock.api.mockResolvedValueOnce(locationBody());
    await getLocationVerification(LOC, { orgId: ORG });
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/locations/${LOC}/verification`, {
      orgId: ORG,
      signal: undefined,
    });
    apiMock.api.mockResolvedValueOnce(locationBody({ page: 3, pageCount: 3 }));
    await getLocationVerification(LOC, { orgId: ORG, page: 3 });
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/locations/${LOC}/verification?page=3`, {
      orgId: ORG,
      signal: undefined,
    });
  });

  it('refuses an answer for another workspace or location', async () => {
    apiMock.api.mockResolvedValueOnce(locationBody({ organizationId: OTHER_ORG }));
    await expect(getLocationVerification(LOC, { orgId: ORG })).rejects.toMatchObject({
      problem: 'workspace',
    });
    apiMock.api.mockResolvedValueOnce(locationBody({ location: { id: ITEM, name: 'X' } }));
    await expect(getLocationVerification(LOC, { orgId: ORG })).rejects.toBeInstanceOf(
      VerificationResponseError,
    );
  });

  it('never sends a malformed id', async () => {
    await expect(getLocationVerification('../x', { orgId: ORG })).rejects.toMatchObject({
      problem: 'invalid_id',
    });
    expect(apiMock.api).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Failed reads
// ═══════════════════════════════════════════════════════════════════════════

describe('describeVerificationError', () => {
  it("the route's 404 says the item or location is not available, with no Try again", () => {
    expect(
      describeVerificationError(apiError(404, 'That item was not found.', 'not_found'), 'item'),
    ).toEqual({
      detail: 'This item is not available to you, or it no longer exists.',
      retry: false,
      keepShown: false,
    });
    expect(describeVerificationError(apiError(404, 'x', 'not_found'), 'location').detail).toBe(
      'This location is not available to you, or it no longer exists.',
    );
  });

  it('a 404 that never reached the route is a server without it yet', () => {
    const v = describeVerificationError(
      apiError(404, 'That is not available on this version of the app.'),
      'item',
    );
    expect(v.detail).toBe('The server does not offer this yet. Try again later.');
    expect(v.retry).toBe(true);
  });

  it('the MFA step-up is worded for the phone, which has no in-place step-up', () => {
    const v = describeVerificationError(
      apiError(403, 'Re-authenticate with MFA before performing this action.', 'forbidden', {
        reason: 'aal2_required',
      }),
      'item',
    );
    expect(v.detail).toContain('authenticator app');
    expect(v.retry).toBe(false);
    expect(
      describeVerificationError(apiError(403, 'x', 'forbidden', { reason: 'mfa_required' }), 'item')
        .detail,
    ).toContain('two-factor');
    expect(
      describeVerificationError(
        apiError(403, 'Missing permission: items:read', 'forbidden'),
        'item',
      ).detail,
    ).toBe('You do not have permission to see this.');
  });

  // L5 (review 2026-09-27): the web card and location page now word a
  // refusal too; both take the words from core, so they cannot drift apart.
  it("a refusal reads in core's words, the ones the web card and location page show", () => {
    const cases: [unknown, 'item' | 'location', string][] = [
      [apiError(404, 'x', 'not_found'), 'item', verificationRefusalCopy('not_found', 'item')],
      [
        apiError(404, 'x', 'not_found'),
        'location',
        verificationRefusalCopy('not_found', 'location'),
      ],
      [apiError(403, 'x', 'forbidden'), 'item', verificationRefusalCopy('forbidden', 'item')],
      [
        apiError(403, 'x', 'forbidden', { reason: 'aal2_required' }),
        'item',
        verificationRefusalCopy('aal2_required', 'item'),
      ],
      [
        apiError(403, 'x', 'forbidden', { reason: 'mfa_required' }),
        'location',
        verificationRefusalCopy('mfa_required', 'location'),
      ],
      [
        apiError(400, 'x', 'validation_error'),
        'location',
        verificationRefusalCopy('invalid_id', 'location'),
      ],
      [apiError(401, 'x', 'unauthenticated'), 'item', VERIFICATION_SESSION_ENDED_COPY],
    ];
    for (const [e, subject, words] of cases) {
      expect(describeVerificationError(e, subject).detail).toBe(words);
    }
    // No hand-written copy of those sentences is left in the phone's module.
    const source = readFileSync(path.resolve(__dirname, 'verification-api.ts'), 'utf8');
    for (const sentence of [
      'is not available to you, or it no longer exists',
      'You do not have permission to see this.',
      'Your session has ended.',
      'authenticator app',
      'requires two-factor authentication',
      "'This link is not valid.'",
    ]) {
      expect(source, sentence).not.toContain(sentence);
    }
  });

  it('keeps the answer on screen only for failures that do not take it away', () => {
    expect(
      describeVerificationError(apiError(500, VERIFICATION_UNAVAILABLE_COPY), 'item'),
    ).toMatchObject({
      retry: true,
      keepShown: true,
    });
    expect(describeVerificationError(apiError(429, 'rate_limited'), 'item')).toMatchObject({
      detail: 'Too many requests. Wait a moment and try again.',
      keepShown: true,
    });
    expect(
      describeVerificationError(
        new Error('Request timed out. Check your connection and try again.'),
        'item',
      ),
    ).toEqual({
      detail: 'Request timed out. Check your connection and try again.',
      retry: true,
      keepShown: true,
    });
    expect(describeVerificationError(apiError(401, 'unauthenticated'), 'item').keepShown).toBe(
      false,
    );
    expect(
      describeVerificationError(new VerificationResponseError('workspace'), 'item').keepShown,
    ).toBe(false);
  });

  it('never shows a bare code as the reason', () => {
    expect(describeVerificationError(new Error('internal_error'), 'item').detail).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  // Simulator walk 2026-09-27: offline, the item card and the location screen
  // put the network layer's own text under "Couldn't load verification":
  // "fetch failed: UnexpectedException: Could not connect to the server. (at
  // ExpoModulesCore/Promise.swift:56)". api() re-throws expo fetch's error
  // unchanged, so anything with no HTTP status is said in the app's words
  // (the rental and recount screens' sentence), never the engine's.
  it('a request that got no answer says the connection sentence, never the network layer text', () => {
    const expoFetch = new TypeError(
      'fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)',
    );
    for (const subject of ['item', 'location'] as const) {
      for (const e of [
        expoFetch,
        new TypeError('Network request failed'),
        new Error('The Internet connection appears to be offline.'),
        'boom',
        null,
        {},
      ]) {
        expect(describeVerificationError(e, subject), String(e)).toEqual({
          detail: 'Could not reach the server. Check your connection and try again.',
          retry: true,
          keepShown: true,
        });
      }
    }
    // The same sentence the phone's other screens say for it.
    expect(CONNECTION_FAILURE_COPY).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it("api()'s own timeout keeps its sentence (the app's words, not the engine's)", () => {
    expect(describeVerificationError(new Error(REQUEST_TIMED_OUT_COPY), 'location').detail).toBe(
      'Request timed out. Check your connection and try again.',
    );
  });

  it('the card and the location screen show the connection sentence offline, never the raw text', () => {
    const KEY = verificationKey(LOC, ORG)!;
    const expoFetch = new TypeError(
      'fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)',
    );
    const stored = verificationFailure<{ timeZone: string }>(
      null,
      KEY,
      expoFetch,
      'location',
      (d) => d.timeZone,
    );
    const view = verificationView(stored, KEY, false, (d) => d.timeZone);
    expect(view).toEqual({
      kind: 'error',
      error: {
        detail: 'Could not reach the server. Check your connection and try again.',
        retry: true,
        keepShown: true,
      },
    });
  });

  // The location screen's "Recount items here" gather failure (walk
  // 2026-09-27: the same raw text reached it).
  it('a recount gather that got no answer says the connection sentence', () => {
    const expoFetch = new TypeError(
      'fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)',
    );
    const words = recountGatherFailureCopy(expoFetch);
    expect(words).toBe(
      'The items here could not be gathered. Could not reach the server. Check your connection and try again.',
    );
    expect(words).not.toMatch(/fetch failed|Promise\.swift|UnexpectedException/);
    expect(recountGatherFailureCopy(apiError(500, 'x'))).toBe(
      'The items here could not be gathered. The server had a problem. Try again in a moment.',
    );
  });
});

describe('verificationFailure and verificationView', () => {
  const tz = (d: MobileItemVerification) => d.timeZone;
  const KEY = verificationKey(ITEM, ORG)!;
  const ready: StoredVerification<MobileItemVerification> = {
    key: KEY,
    kind: 'ready',
    data: parseItemVerification(itemBody()),
    receivedAt: '2026-09-27T17:40:00Z',
    banner: null,
  };

  it('keys by workspace and subject (and page)', () => {
    expect(verificationKey(ITEM, ORG)).not.toBe(verificationKey(ITEM, OTHER_ORG));
    expect(verificationKey(LOC, ORG, 1)).not.toBe(verificationKey(LOC, ORG, 2));
    expect(verificationKey(ITEM, null)).toBeNull();
    expect(verificationKey(undefined, ORG)).toBeNull();
  });

  // Mutation caught: dropping the answer on screen for a dropped connection,
  // or keeping it after the reader lost access.
  it('a refresh that failed on the connection keeps the answer "as of" its time', () => {
    const next = verificationFailure(ready, KEY, new Error('Network request failed'), 'item', tz);
    expect(next).toMatchObject({
      kind: 'ready',
      banner: 'Could not refresh. Showing this as of Sep 27, 10:40 AM.',
    });
  });

  it('a refusal replaces the answer with the failure', () => {
    const next = verificationFailure(ready, KEY, apiError(404, 'x', 'not_found'), 'item', tz);
    expect(next).toEqual({
      key: KEY,
      kind: 'error',
      error: describeVerificationError(apiError(404, 'x', 'not_found'), 'item'),
    });
  });

  it("another key's answer is never kept", () => {
    const other = verificationKey(ITEM_2, ORG)!;
    expect(
      verificationFailure(ready, other, new Error('Network request failed'), 'item', tz).kind,
    ).toBe('error');
  });

  it("shows only this key's answer; anything else is still loading", () => {
    expect(verificationView(ready, KEY, false, tz).kind).toBe('ready');
    expect(verificationView(ready, verificationKey(ITEM, OTHER_ORG), false, tz)).toEqual({
      kind: 'loading',
    });
    expect(verificationView(null, KEY, false, tz)).toEqual({ kind: 'loading' });
    expect(verificationView(ready, null, false, tz)).toEqual({ kind: 'loading' });
  });

  it('offline: the answer on screen with its time, or that it needs a connection (no Try again)', () => {
    expect(verificationView(ready, KEY, true, tz)).toMatchObject({
      kind: 'ready',
      banner: 'You are offline. Showing this as of Sep 27, 10:40 AM.',
    });
    expect(verificationView(null, KEY, true, tz)).toEqual({
      kind: 'error',
      error: { detail: VERIFICATION_OFFLINE_COPY, retry: false, keepShown: false },
    });
  });

  it('a stored failure is shown as the failure', () => {
    const failed = verificationFailure(null, KEY, apiError(500, 'x'), 'item', tz);
    expect(verificationView(failed, KEY, false, tz)).toEqual({
      kind: 'error',
      error: {
        detail: 'The server had a problem. Try again in a moment.',
        retry: true,
        keepShown: true,
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The words the screens add
// ═══════════════════════════════════════════════════════════════════════════

describe('screen words', () => {
  it('Checked at, in the org zone; before the first check, never an all-clear', () => {
    expect(verificationCheckedAtCopy('2026-09-27T14:00:00Z', TZ)).toBe(
      'Checked at Sep 27, 7:00 AM.',
    );
    expect(verificationCheckedAtCopy(null, TZ)).toBe(EXCEPTION_FIRST_CHECK_PENDING_COPY);
  });

  it('names the kind of location as the web page does, and a site by its type', () => {
    expect(locationKindLabel('rack', null)).toBe('Rack');
    expect(locationKindLabel('crate', null)).toBe('Crate');
    // Staging and Unplaced are system locations, never a shelf.
    expect(locationKindLabel('unplaced', 'rack')).toBe('System location');
    expect(locationKindLabel('staging', null)).toBe('System location');
    expect(locationKindLabel(null, 'warehouse')).toBe('Warehouse');
    expect(locationKindLabel(null, 'jobsite')).toBe('Job site');
    expect(locationKindLabel(null, 'a_new_type')).toBe('Location');
    expect(locationKindLabel(null, null)).toBe('Location');
  });

  // The web's rule (lib/verification/count-page-access.ts): a count is linked
  // only for a reader the count screen lets in.
  it('links a count only for a reader who can open counts', () => {
    // Role defaults (core ROLE_PERMISSIONS): staff hold cycle_counts:read,
    // viewers hold neither permission.
    expect(canOpenCountScreen('staff', undefined)).toBe(true);
    expect(canOpenCountScreen('viewer', undefined)).toBe(false);
    // The effective set decides once loaded (an override that revokes both).
    expect(canOpenCountScreen('staff', new Set())).toBe(false);
    expect(canOpenCountScreen('viewer', new Set(['cycle_counts:read']))).toBe(true);
    expect(canOpenCountScreen('staff', new Set(['stock:adjust']))).toBe(true);
    expect(canOpenCountScreen('staff', new Set(['cycle_counts:read']))).toBe(true);
    expect(canOpenCountScreen(null, new Set(['cycle_counts:read']))).toBe(false);
  });

  it('the truncated totals say the cap', () => {
    expect(LOCATION_HOLDINGS_TRUNCATED_COPY).toBe(
      'Only the first 20,000 holdings here were read, so these totals are partial.',
    );
  });

  it('a row reads to VoiceOver as one sentence in the order it is shown', () => {
    const row = parseLocationVerification(locationBody()).rows[0]!;
    const copy = locationRowVerificationCopy(row.summary, LOC, {
      timeZone: TZ,
      locationKind: 'rack',
    });
    expect(locationRowQuantityCopy(12)).toBe('12 here');
    expect(
      locationRowAccessibilityLabel(row, copy, ['EX-000042 · Count did not match the stock on record']),
    ).toBe(
      `${row.name}, SKU-1. 12 here. Counted Sep 12, 2026, while this was its only shelf location. 0 recorded stock movements since. EX-000042 · Count did not match the stock on record`,
    );
  });

  // The owner's rule: the words never say "verified" and never show a percentage.
  it('no word here says verified or shows a percentage', () => {
    const words = (Object.values(verification) as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
    expect(words.length).toBeGreaterThan(5);
    for (const w of [
      ...words,
      describeVerificationError(
        apiError(403, 'x', 'forbidden', { reason: 'aal2_required' }),
        'item',
      ).detail,
      verificationCheckedAtCopy('2026-09-27T14:00:00Z', TZ),
    ]) {
      expect(w).not.toMatch(/\bverified\b|%/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// "Recount items here"
// ═══════════════════════════════════════════════════════════════════════════

describe('locationRecountState', () => {
  const v = parseLocationVerification(locationBody());

  it('only for a reader the server says may recount, and only where stock is listed', () => {
    expect(locationRecountState({ ...v, canRecount: false }, true)).toEqual({
      show: false,
      disabledReason: null,
    });
    expect(locationRecountState({ ...v, holdingsVisible: false, totals: null }, true).show).toBe(
      false,
    );
    expect(locationRecountState(v, true)).toEqual({ show: true, disabledReason: null });
  });

  it("disabled with the server's reason when nothing or too much here can be counted", () => {
    expect(
      locationRecountState({ ...v, recountProblem: 'Nothing here can be counted.' }, true),
    ).toEqual({
      show: true,
      disabledReason: 'Nothing here can be counted.',
    });
  });

  it('disabled when the totals are partial', () => {
    expect(locationRecountState({ ...v, truncated: true }, true).disabledReason).toBe(
      LOCATION_HOLDINGS_TRUNCATED_COPY,
    );
  });

  // Mutation caught: `online: true`.
  it('offline it is disabled with the reason', () => {
    expect(locationRecountState(v, false).disabledReason).toBe(RECOUNT_OFFLINE_COPY);
  });
});

describe('gatherRecountItemIds', () => {
  const rental = (id: string) =>
    rowJson(id, {
      summary: summaryJson(
        {
          item: {
            status: 'active',
            isRental: true,
            isBundle: false,
            deleted: false,
            countable: false,
            quantityOnHand: 3,
          },
        },
        id,
      ),
    });
  const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;

  function pageOf(
    p: number,
    pageCount: number,
    rows: unknown[],
    countable: number,
    o: Record<string, unknown> = {},
  ) {
    return parseLocationVerification(
      locationBody({
        page: p,
        pageCount,
        rows,
        totalRows: pageCount * 50,
        totals: totalsJson({ items: pageCount * 50, countable }),
        ...o,
      }),
    );
  }

  // Mutation caught: ignoring the server's list and gathering (or counting
  // only the page on screen).
  it("uses the server's list as it came, with no further read", async () => {
    const current = pageOf(1, 4, [rowJson(id(1))], 3, {
      recountItemIds: [id(1), id(7), id(9), id(7)],
    });
    const fetchPage = vi.fn();
    await expect(gatherRecountItemIds(current, fetchPage)).resolves.toEqual({
      ok: true,
      itemIds: [id(1), id(7), id(9)],
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('an empty or oversized server list is refused with the reason', async () => {
    const fetchPage = vi.fn();
    await expect(
      gatherRecountItemIds(pageOf(1, 1, [rowJson(id(1))], 1, { recountItemIds: [] }), fetchPage),
    ).resolves.toEqual({ ok: false, message: 'Nothing here can be counted.' });
    const many = Array.from({ length: 201 }, (_, n) => id(n + 1));
    const res = await gatherRecountItemIds(
      pageOf(1, 5, [], 201, { recountItemIds: many }),
      fetchPage,
    );
    expect(res.ok).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('one page: the countable rows on screen, and no further read', async () => {
    const current = pageOf(
      1,
      1,
      [rowJson(id(1)), rental(id(2)), rowJson(id(3), { summary: null }), rowJson(id(4))],
      2,
    );
    const fetchPage = vi.fn();
    await expect(gatherRecountItemIds(current, fetchPage)).resolves.toEqual({
      ok: true,
      itemIds: [id(1), id(4)],
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  // Mutation caught: gathering only the page on screen, which left every item
  // on the other pages out of the recount without a word.
  it('several pages: reads every page and gathers across them', async () => {
    const pages = [
      pageOf(1, 3, [rowJson(id(1)), rental(id(2))], 3),
      pageOf(2, 3, [rowJson(id(3))], 3),
      pageOf(3, 3, [rowJson(id(5))], 3),
    ];
    const fetchPage = vi.fn(async (p: number) => pages[p - 1]!);
    await expect(gatherRecountItemIds(pages[1]!, fetchPage)).resolves.toEqual({
      ok: true,
      itemIds: [id(1), id(3), id(5)],
    });
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  // Mutation caught: trusting whatever was gathered.
  it('refuses when the stock changed while the pages were read', async () => {
    const first = pageOf(1, 2, [rowJson(id(1))], 2);
    const moved = pageOf(2, 2, [rowJson(id(3))], 3);
    await expect(
      gatherRecountItemIds(first, async (p) => (p === 1 ? first : moved)),
    ).resolves.toEqual({
      ok: false,
      message: RECOUNT_GATHER_CHANGED_COPY,
    });
    // The pages agree with each other but not with what was gathered.
    const short = pageOf(1, 2, [rowJson(id(1))], 3);
    const second = pageOf(2, 2, [rowJson(id(3))], 3);
    await expect(
      gatherRecountItemIds(short, async (p) => (p === 1 ? short : second)),
    ).resolves.toEqual({
      ok: false,
      message: RECOUNT_GATHER_CHANGED_COPY,
    });
  });

  it('refuses a page from another workspace', async () => {
    const first = pageOf(1, 2, [rowJson(id(1))], 2);
    const foreign = pageOf(2, 2, [rowJson(id(3))], 2, { organizationId: OTHER_ORG });
    await expect(
      gatherRecountItemIds(first, async (p) => (p === 1 ? first : foreign)),
    ).resolves.toEqual({
      ok: false,
      message: RECOUNT_GATHER_CHANGED_COPY,
    });
  });

  it('refuses nothing to count, too many items, or too many pages, without reading', async () => {
    const fetchPage = vi.fn();
    await expect(gatherRecountItemIds(pageOf(1, 2, [], 0), fetchPage)).resolves.toEqual({
      ok: false,
      message: 'Nothing here can be counted.',
    });
    const tooMany = await gatherRecountItemIds(pageOf(1, 5, [], 201), fetchPage);
    expect(tooMany.ok).toBe(false);
    expect(!tooMany.ok && tooMany.message).toContain('at most 200 items');
    await expect(
      gatherRecountItemIds(pageOf(1, RECOUNT_GATHER_MAX_PAGES + 1, [], 10), fetchPage),
    ).resolves.toEqual({ ok: false, message: RECOUNT_GATHER_TOO_MANY_PAGES_COPY });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('a failed page read rejects (the screen says the items could not be gathered)', async () => {
    const first = pageOf(1, 2, [rowJson(id(1))], 2);
    await expect(
      gatherRecountItemIds(first, async () => {
        throw apiError(500, VERIFICATION_UNAVAILABLE_COPY);
      }),
    ).rejects.toThrow(VERIFICATION_UNAVAILABLE_COPY);
  });
});
