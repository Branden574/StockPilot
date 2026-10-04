/**
 * Placing an order request (place-order.ts): the body's schema and caps, the
 * answers' parsers, what each answer means for the key (plan 3.4's table, row
 * by row, from ApiError-shaped errors), the state machine, the pending record
 * and the words.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { NEEDED_BY_IN_PAST_COPY, NEEDED_BY_OUT_OF_RANGE_COPY } from './needed-by-words';
import {
  classifyOrderSettleResult,
  classifyOrderSubmitResult,
  isOrderWallClock,
  mintOrderSubmissionKey,
  OrderAnswerShapeError,
  orderAlreadyPlacedCopy,
  orderCallResultFromAction,
  orderCallResultForOrganization,
  orderSubmissionCanResend,
  ORDER_ADD_WHILE_LOCKED_COPY,
  ORDER_ORGANIZATION_CHANGED_COPY,
  ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
  ORDER_PAGE_OUT_OF_DATE_COPY,
  ORDER_PAGE_OUT_OF_DATE_FINAL_COPY,
  ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
  ORDER_EMAIL_MAX,
  ORDER_NOTES_MAX,
  ORDER_REFUSED_FINAL_COPY,
  ORDER_RESEND_REFUSED_COPY,
  ORDER_TIMEZONE_UNREADABLE_COPY,
  ORDER_UNCONFIRMED_STALE_BODY_COPY,
  ORDER_BODY_UNREADABLE_COPY,
  ORDER_BUSY_COPY,
  ORDER_CONFLICT_COPY,
  ORDER_DELIVERY_NEEDS_SITE_COPY,
  ORDER_FAULT_COPY,
  ORDER_LINES_EMPTY_COPY,
  ORDER_MAX_LINES,
  ORDER_MAX_UNITS,
  ORDER_NEEDED_BY_INVALID_TIME_COPY,
  ORDER_NOTES_TOO_LONG_COPY,
  ORDER_ON_BEHALF_INVALID_COPY,
  ORDER_ON_BEHALF_NOT_PERMITTED_COPY,
  ORDER_PHONE_AAL2_UNCONFIRMED_COPY,
  ORDER_PHONE_UNAVAILABLE_COPY,
  ORDER_PICKUP_HAS_SITE_COPY,
  ORDER_QUANTITY_INVALID_COPY,
  ORDER_QUANTITY_NOT_WHOLE_COPY,
  ORDER_RATE_LIMITED_COPY,
  ORDER_REFUSED_RESEND_SUFFIX_COPY,
  ORDER_SIGN_IN_COPY,
  ORDER_SITE_INACTIVE_COPY,
  ORDER_SUBMISSION_OPEN,
  ORDER_TOO_MANY_LINES_COPY,
  ORDER_TOO_MANY_UNITS_COPY,
  ORDER_UNCONFIRMED_BODY_COPY,
  ORDER_WITHDRAWN_COPY,
  orderCreateRequestSchema,
  orderItemRefusalCopy,
  orderRefusalCopy,
  orderSubmissionLocked,
  orderSubmissionReducer,
  orderUnconfirmedCopy,
  parseOrderCreateRequest,
  parseOrderPlaceAnswer,
  parseOrderSubmissionStatus,
  parsePendingOrderSubmission,
  pendingOrderSubmissionOf,
  randomRequestUuid,
  readOrderRefusalDetails,
  refuseAddWhileLocked,
  type OrderCallResult,
  type OrderCreateRequestInput,
  type OrderSubmissionEvent,
  type OrderSubmissionState,
  type PendingOrderSubmission,
} from './place-order';
import * as placeOrder from './place-order';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = '7d1f0c52-3a4b-4c6d-8e9f-0a1b2c3d4e5f';
const PLACER = '11111111-2222-4333-8444-555555555555';
const OTHER_USER = '99999999-2222-4333-8444-555555555555';
const WAREHOUSE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SITE = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ITEM_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ITEM_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ORDER_ID = 'dddddddd-0000-4000-8000-000000000001';
const ORG = 'eeeeeeee-0000-4000-8000-000000000001';

/** A valid body: pickup, for the placer, one line. */
function body(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: KEY,
    placerUserId: PLACER,
    warehouseId: WAREHOUSE,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    onBehalfOf: null,
    notes: null,
    neededByLocal: null,
    lines: [{ itemId: ITEM_A, quantity: 2 }],
    ...patch,
  };
}

function itemId(n: number): string {
  return `0c0c0c0c-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function refusal(raw: unknown) {
  const r = parseOrderCreateRequest(raw);
  if (r.ok) throw new Error('expected a refusal');
  return r.refusal;
}

// ── The schema ──────────────────────────────────────────────────────────────

describe('orderCreateRequestSchema: what is accepted', () => {
  it('accepts a pickup order for oneself', () => {
    const r = parseOrderCreateRequest(body());
    expect(r).toEqual({ ok: true, value: body() });
  });

  it('accepts a delivery on behalf, with kits, and trims the name, the email and the notes', () => {
    const r = parseOrderCreateRequest(
      body({
        fulfillmentType: 'delivery',
        deliveryCharterId: SITE,
        onBehalfOf: { name: '  Maria Lopez ', email: ' maria@example.org\t' },
        notes: '\n  Room 12, by Friday  \n',
        neededByLocal: '2026-10-05T10:00',
        lines: [
          { itemId: ITEM_A, quantity: 2 },
          { itemId: ITEM_B, quantity: 10 },
        ],
        kits: [{ bundleId: SITE, count: 2 }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.onBehalfOf).toEqual({ name: 'Maria Lopez', email: 'maria@example.org' });
    expect(r.value.notes).toBe('Room 12, by Friday');
    expect(r.value.neededByLocal).toBe('2026-10-05T10:00');
    expect(r.value.kits).toEqual([{ bundleId: SITE, count: 2 }]);
  });

  it('reads blank notes as none', () => {
    const r = parseOrderCreateRequest(body({ notes: ' \n\t ' }));
    expect(r.ok && r.value.notes).toBe(null);
  });

  it('accepts the caps exactly', () => {
    const lines = Array.from({ length: ORDER_MAX_LINES }, (_, i) => ({
      itemId: itemId(i + 1),
      quantity: 1,
    }));
    expect(parseOrderCreateRequest(body({ lines })).ok).toBe(true);
    expect(
      parseOrderCreateRequest(body({ lines: [{ itemId: ITEM_A, quantity: ORDER_MAX_UNITS }] })).ok,
    ).toBe(true);
    expect(parseOrderCreateRequest(body({ notes: 'n'.repeat(2000) })).ok).toBe(true);
    expect(
      parseOrderCreateRequest(body({ onBehalfOf: { name: 'n'.repeat(120), email: 'a@b.co' } })).ok,
    ).toBe(true);
    const email = `${'e'.repeat(254 - '@example.org'.length)}@example.org`;
    expect(email).toHaveLength(254);
    expect(parseOrderCreateRequest(body({ onBehalfOf: { name: 'N', email } })).ok).toBe(true);
  });

  it('counts characters as the database does: one per code point, not per UTF-16 unit', () => {
    // U+1D400 is two UTF-16 units and one character.
    const notes = '\u{1D400}'.repeat(2000);
    expect(notes.length).toBe(4000);
    expect(parseOrderCreateRequest(body({ notes })).ok).toBe(true);
    expect(refusal(body({ notes: notes + 'x' })).reason).toBe('notes_too_long');
  });

  it('accepts lines of the same item (the database sums them) when the sum is within the caps', () => {
    expect(
      parseOrderCreateRequest(
        body({
          lines: [
            { itemId: ITEM_A, quantity: 3 },
            { itemId: ITEM_A, quantity: 4 },
          ],
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("orderCreateRequestSchema: every refusal, with core's words", () => {
  const cases: Array<[string, Record<string, unknown>, string, string | undefined, string]> = [
    ['no lines', body({ lines: [] }), 'invalid', 'lines', ORDER_LINES_EMPTY_COPY],
    [
      '101 lines',
      body({
        lines: Array.from({ length: 101 }, (_, i) => ({ itemId: itemId(i + 1), quantity: 1 })),
      }),
      'too_many_lines',
      undefined,
      ORDER_TOO_MANY_LINES_COPY,
    ],
    [
      'a quantity of 0',
      body({ lines: [{ itemId: ITEM_A, quantity: 0 }] }),
      'invalid',
      'quantity',
      ORDER_QUANTITY_INVALID_COPY,
    ],
    [
      'a negative quantity',
      body({ lines: [{ itemId: ITEM_A, quantity: -3 }] }),
      'invalid',
      'quantity',
      ORDER_QUANTITY_INVALID_COPY,
    ],
    [
      'a quantity of 10,001',
      body({ lines: [{ itemId: ITEM_A, quantity: 10_001 }] }),
      'too_many_units',
      undefined,
      ORDER_TOO_MANY_UNITS_COPY,
    ],
    [
      'a quantity of 1.5',
      body({ lines: [{ itemId: ITEM_A, quantity: 1.5 }] }),
      'quantity_not_whole',
      undefined,
      ORDER_QUANTITY_NOT_WHOLE_COPY,
    ],
    [
      'a quantity of 0.5',
      body({ lines: [{ itemId: ITEM_A, quantity: 0.5 }] }),
      'quantity_not_whole',
      undefined,
      ORDER_QUANTITY_NOT_WHOLE_COPY,
    ],
    [
      'a quantity sent as text',
      body({ lines: [{ itemId: ITEM_A, quantity: '2' }] }),
      'invalid',
      'quantity',
      ORDER_QUANTITY_INVALID_COPY,
    ],
    [
      'a total of 10,001',
      body({
        lines: [
          { itemId: ITEM_A, quantity: 5000 },
          { itemId: ITEM_B, quantity: 5001 },
        ],
      }),
      'too_many_units',
      undefined,
      ORDER_TOO_MANY_UNITS_COPY,
    ],
    [
      '2,001-character notes',
      body({ notes: 'n'.repeat(2001) }),
      'notes_too_long',
      undefined,
      ORDER_NOTES_TOO_LONG_COPY,
    ],
    [
      'a 121-character name',
      body({ onBehalfOf: { name: 'n'.repeat(121), email: 'maria@example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'a blank name',
      body({ onBehalfOf: { name: '   ', email: 'maria@example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'an email with no @',
      body({ onBehalfOf: { name: 'Maria', email: 'maria.example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'an email with two @',
      body({ onBehalfOf: { name: 'Maria', email: 'maria@x@example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'an email with a space',
      body({ onBehalfOf: { name: 'Maria', email: 'maria lopez@example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'a 255-character email',
      body({
        onBehalfOf: {
          name: 'Maria',
          email: `${'e'.repeat(255 - '@example.org'.length)}@example.org`,
        },
      }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'a name with no email',
      body({ onBehalfOf: { name: 'Maria' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'delivery without a site',
      body({ fulfillmentType: 'delivery' }),
      'delivery_needs_site',
      undefined,
      ORDER_DELIVERY_NEEDS_SITE_COPY,
    ],
    [
      'pickup with a site',
      body({ deliveryCharterId: SITE }),
      'invalid',
      'pickupSite',
      ORDER_PICKUP_HAS_SITE_COPY,
    ],
    [
      'a delivery whose site id is not a uuid (a client fault, not a pickup with a site)',
      body({ fulfillmentType: 'delivery', deliveryCharterId: 'clovis' }),
      'invalid',
      'deliveryCharterId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a missing site key',
      (() => {
        const b = body();
        delete b.deliveryCharterId;
        return b;
      })(),
      'invalid',
      'deliveryCharterId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an unknown key named like a field with its own words (quantity)',
      body({ quantity: 3 }),
      'invalid',
      'body',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an unknown key named like a field with its own words (pickupSite)',
      body({ pickupSite: SITE }),
      'invalid',
      'body',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an unknown key on a line named like a field with its own words (lines)',
      body({ lines: [{ itemId: ITEM_A, quantity: 1, lines: 2 }] }),
      'invalid',
      'body',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an email with a one-letter top-level domain (the web refuses it today)',
      body({ onBehalfOf: { name: 'Maria', email: 'maria@gmail.c' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'an email with two dots in a row',
      body({ onBehalfOf: { name: 'Maria', email: 'maria..lopez@example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'an email with a no-break space inside',
      body({ onBehalfOf: { name: 'Maria', email: 'maria lopez@example.org' } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'a method that is neither',
      body({ fulfillmentType: 'shipping' }),
      'invalid',
      'fulfillmentType',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a needed-by with seconds',
      body({ neededByLocal: '2026-10-05T10:00:00' }),
      'needed_by_invalid_time',
      undefined,
      ORDER_NEEDED_BY_INVALID_TIME_COPY,
    ],
    [
      'a needed-by that is an instant',
      body({ neededByLocal: '2026-10-05T17:00:00.000Z' }),
      'needed_by_invalid_time',
      undefined,
      ORDER_NEEDED_BY_INVALID_TIME_COPY,
    ],
    [
      'a needed-by of 30 February',
      body({ neededByLocal: '2027-02-30T10:00' }),
      'needed_by_invalid_time',
      undefined,
      ORDER_NEEDED_BY_INVALID_TIME_COPY,
    ],
    [
      'a needed-by at 24:00',
      body({ neededByLocal: '2026-10-05T24:00' }),
      'needed_by_invalid_time',
      undefined,
      ORDER_NEEDED_BY_INVALID_TIME_COPY,
    ],
    [
      'a needed-by date with no time',
      body({ neededByLocal: '2026-10-05' }),
      'needed_by_invalid_time',
      undefined,
      ORDER_NEEDED_BY_INVALID_TIME_COPY,
    ],
    [
      'a missing key',
      (() => {
        const b = body();
        delete b.idempotencyKey;
        return b;
      })(),
      'invalid',
      'idempotencyKey',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a malformed key',
      body({ idempotencyKey: 'shortfall-123' }),
      'invalid',
      'idempotencyKey',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a missing placer',
      (() => {
        const b = body();
        delete b.placerUserId;
        return b;
      })(),
      'invalid',
      'placerUserId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a malformed placer',
      body({ placerUserId: 'me' }),
      'invalid',
      'placerUserId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a malformed warehouse',
      body({ warehouseId: 42 }),
      'invalid',
      'warehouseId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a malformed item id',
      body({ lines: [{ itemId: 'item-1', quantity: 1 }] }),
      'invalid',
      'itemId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a line that is not an object',
      body({ lines: [ITEM_A] }),
      'invalid',
      'line',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a missing notes key',
      (() => {
        const b = body();
        delete b.notes;
        return b;
      })(),
      'invalid',
      'notes',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an unknown key (.strict())',
      body({ price: 1 }),
      'invalid',
      'price',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'a requester id smuggled in (.strict())',
      body({ requesterUserId: OTHER_USER }),
      'invalid',
      'requesterUserId',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an unknown key on a line',
      body({ lines: [{ itemId: ITEM_A, quantity: 1, unitCost: 0 }] }),
      'invalid',
      'unitCost',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      'an unknown key on the requester',
      body({ onBehalfOf: { name: 'Maria', email: 'maria@example.org', userId: OTHER_USER } }),
      'on_behalf_invalid',
      undefined,
      ORDER_ON_BEHALF_INVALID_COPY,
    ],
    [
      'a bad kit',
      body({ kits: [{ bundleId: SITE, count: 0 }] }),
      'invalid',
      'kits',
      ORDER_BODY_UNREADABLE_COPY,
    ],
    [
      '101 kits',
      body({ kits: Array.from({ length: 101 }, () => ({ bundleId: SITE, count: 1 })) }),
      'invalid',
      'kits',
      ORDER_BODY_UNREADABLE_COPY,
    ],
  ];

  it.each(cases)('%s', (_title, raw, reason, field, message) => {
    const r = refusal(raw);
    expect(r.reason).toBe(reason);
    expect(r.field).toBe(field);
    expect(r.message).toBe(message);
  });

  it('a body that is not an object', () => {
    for (const raw of [null, undefined, 'order', 42, [body()]]) {
      expect(refusal(raw)).toEqual({
        reason: 'invalid',
        field: 'body',
        message: ORDER_BODY_UNREADABLE_COPY,
      });
    }
  });

  it("a direct safeParse puts core's sentence on every issue, never zod's", () => {
    for (const [, raw] of cases) {
      const r = orderCreateRequestSchema().safeParse(raw);
      expect(r.success).toBe(false);
      if (r.success) continue;
      for (const issue of r.error.issues) {
        expect(issue.message, JSON.stringify(issue)).not.toMatch(
          /^(Expected|Invalid|Required|String must|Number must|Array must|Unrecognized)/,
        );
      }
    }
  });

  it('the schema is built once, on first use', () => {
    expect(orderCreateRequestSchema()).toBe(orderCreateRequestSchema());
  });
});

describe('the on-behalf email: the rule the web applies today', () => {
  // apps/web/src/server/actions/order-requests.ts reads the on-behalf email
  // with z.string().trim().email().max(254). PO-2 moves the web onto core,
  // so core must accept and refuse exactly what that accepts and refuses.
  const webToday = z.string().trim().email().max(254);
  const corpus = [
    'maria@example.org',
    'MARIA.LOPEZ@EXAMPLE.ORG',
    "o'neil+orders@sub.example.co.uk",
    'a_b-c@x-y.org',
    'a@b.co',
    'a@xn--bcher-kva.example',
    '  maria@example.org\t',
    ' maria@example.org﻿',
    ' maria@example.org ',
    'maria@gmail.c',
    'maria@example.o1',
    'maria..lopez@example.org',
    '.maria@example.org',
    'maria.@example.org',
    'maria@example..org',
    '"maria"@example.org',
    'maria@-example.org',
    'maria@example_x.org',
    'maría@example.org',
    'maria@exämple.org',
    'maria@1.2.3.4',
    'maria@[10.0.0.1]',
    'maria@localhost',
    'maria lopez@example.org',
    'maria lopez@example.org',
    'maria@x@example.org',
    'maria.example.org',
    '@example.org',
    'maria@',
    '',
    `${'e'.repeat(242)}@example.org`,
    `${'e'.repeat(243)}@example.org`,
  ];

  it.each(corpus)('%j', (email) => {
    const web = webToday.safeParse(email).success;
    const core = parseOrderCreateRequest(body({ onBehalfOf: { name: 'Maria', email } })).ok;
    expect(core).toBe(web);
  });

  it('refuses the addresses the plan sketch let through', () => {
    for (const email of ['maria@gmail.c', 'maria..lopez@example.org', '"q"@x.yz', 'a@-x.yz']) {
      expect(refusal(body({ onBehalfOf: { name: 'Maria', email } })).reason).toBe(
        'on_behalf_invalid',
      );
    }
    expect(ORDER_EMAIL_MAX).toBe(254);
  });
});

describe('isOrderOnBehalfValid: the create schema’s own rule, for a client to refuse first (phone desk check F11)', () => {
  it('accepts what the schema accepts and refuses what it refuses', async () => {
    const { isOrderOnBehalfValid, ORDER_ON_BEHALF_NAME_MAX: NAME_MAX } = await import('./place-order');
    const cases: { name: string; email: string }[] = [
      { name: 'Bee Person', email: 'bee@orgb.example' },
      { name: '  Bee  ', email: '  bee@orgb.example ' },
      { name: 'x'.repeat(NAME_MAX), email: 'a@b.co' },
      { name: 'x'.repeat(NAME_MAX + 1), email: 'a@b.co' },
      { name: '', email: 'a@b.co' },
      { name: '   ', email: 'a@b.co' },
      { name: 'Bee', email: 'not an email' },
      { name: 'Bee', email: 'bee@orgb' },
      { name: 'Bee', email: `${'a'.repeat(250)}@b.co` },
      { name: 'Bee', email: '' },
    ];
    for (const who of cases) {
      const body = {
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
        placerUserId: '22222222-2222-4222-8222-222222222222',
        warehouseId: '33333333-3333-4333-8333-333333333333',
        fulfillmentType: 'pickup',
        deliveryCharterId: null,
        onBehalfOf: who,
        notes: null,
        neededByLocal: null,
        lines: [{ itemId: '44444444-4444-4444-8444-444444444444', quantity: 1 }],
      };
      expect(isOrderOnBehalfValid(who), JSON.stringify(who)).toBe(parseOrderCreateRequest(body).ok);
    }
    expect(isOrderOnBehalfValid({ name: 'Bee', email: 'bee@orgb.example' })).toBe(true);
    expect(isOrderOnBehalfValid({ name: 'Bee', email: 'nope' })).toBe(false);
  });
});

describe('importing this module runs nothing', () => {
  // Core's index re-exports place-order, so every web page that bundles core
  // and the phone at start-up evaluate its top level. A call there (a zod
  // chain, a formatter) is kept by the web's tree-shaking (core has no
  // "sideEffects": false) and run by Metro, which does not tree-shake. The
  // PO-1 review measured +3,608 bytes on 129 web routes from exactly that.
  function topLevelCalls(rel: string): string[] {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), rel);
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      // A function's or a class's body runs when it is called, not on import.
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
        found.push(n.getText(sf).slice(0, 60));
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
      visit(st);
    }
    return found;
  }

  it.each(['place-order.ts', 'storefront/copy.ts'])('%s has no call at its top level', (rel) => {
    expect(topLevelCalls(rel)).toEqual([]);
  });

  it("place-order.ts does not pull the needed-by revision dialog into the New order page (review round 1)", () => {
    // Web chunks include whole modules: importing two sentences from
    // needed-by-revision.ts shipped the revision dialog's words on the
    // storefront (2.4 kB raw, 0.9 kB gzip, measured on the production build).
    // The shared needed-by words live in needed-by-words.ts.
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'place-order.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = sf.statements
      .filter(ts.isImportDeclaration)
      .map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    expect(imports).not.toContain('./needed-by-revision');
    expect(imports).toContain('./needed-by-words');
  });

  it('the guard sees a top-level call', () => {
    const probe = ts.createSourceFile('x.ts', 'const a = f(); const b = () => g();', 99, true);
    const calls: string[] = [];
    probe.forEachChild(function visit(n): void {
      if (ts.isFunctionLike(n)) return;
      if (ts.isCallExpression(n)) calls.push(n.getText(probe));
      n.forEachChild(visit);
    });
    expect(calls).toEqual(['f()']);
  });

  it('the cap sentences are written out, and still say the caps', () => {
    expect(ORDER_TOO_MANY_UNITS_COPY).toBe(
      `An order request can have at most ${ORDER_MAX_UNITS.toLocaleString('en-US')} units.`,
    );
    expect(ORDER_NOTES_TOO_LONG_COPY).toBe(
      `Manager notes can be at most ${ORDER_NOTES_MAX.toLocaleString('en-US')} characters.`,
    );
  });
});

describe('isOrderWallClock', () => {
  it('knows the calendar, zone-free', () => {
    expect(isOrderWallClock('2028-02-29T23:59')).toBe(true);
    expect(isOrderWallClock('2027-02-29T10:00')).toBe(false);
    expect(isOrderWallClock('2100-02-29T10:00')).toBe(false);
    expect(isOrderWallClock('2000-02-29T00:00')).toBe(true);
    expect(isOrderWallClock('2026-04-31T10:00')).toBe(false);
    expect(isOrderWallClock('2026-13-01T10:00')).toBe(false);
    expect(isOrderWallClock('2026-10-05T10:60')).toBe(false);
    // The spring-forward hour exists as a wall clock; whether it exists in the
    // organization's zone is the server's question.
    expect(isOrderWallClock('2027-03-14T02:30')).toBe(true);
  });
});

// ── Keys ────────────────────────────────────────────────────────────────────

describe('mintOrderSubmissionKey / randomRequestUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints a version 4 uuid, a new one each time', () => {
    const a = mintOrderSubmissionKey();
    const b = mintOrderSubmissionKey();
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it('falls back to getRandomValues, then to Math.random, when the runtime lacks randomUUID', () => {
    const fill = vi.fn((a: Uint8Array) => {
      for (let i = 0; i < a.length; i += 1) a[i] = (i * 37) & 0xff;
      return a;
    });
    vi.stubGlobal('crypto', { getRandomValues: fill });
    const viaBytes = randomRequestUuid();
    expect(fill).toHaveBeenCalledTimes(1);
    expect(viaBytes).toMatch(UUID);

    vi.stubGlobal('crypto', undefined);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const k = randomRequestUuid();
      expect(k).toMatch(UUID);
      seen.add(k);
    }
    expect(seen.size).toBe(200);
  });

  it('every key it mints passes the body schema', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(parseOrderCreateRequest(body({ idempotencyKey: mintOrderSubmissionKey() })).ok).toBe(
        true,
      );
    }
  });
});

// ── The answers ─────────────────────────────────────────────────────────────

function summary(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    orderNumber: 123,
    orderLabel: 'SO-000123',
    status: 'pending_approval',
    warehouseId: WAREHOUSE,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    neededBy: '2026-10-05T17:00:00+00:00',
    lineCount: 1,
    unitCount: 2,
    createdAt: '2026-10-03T16:00:00+00:00',
    requestedFor: { self: true },
    ...patch,
  };
}

const placeAnswer = (replay: boolean, order = summary()) => ({
  organizationId: ORG,
  result: { replay, order },
});

describe('parseOrderPlaceAnswer', () => {
  it('reads the documented shape, and ignores keys it does not know', () => {
    const a = parseOrderPlaceAnswer({ ...placeAnswer(false, summary({ extra: 1 })), served: 'v2' });
    expect(a.organizationId).toBe(ORG);
    expect(a.replay).toBe(false);
    expect(a.order).toEqual({ ...summary(), requestedFor: { self: true } });
    expect('extra' in a.order).toBe(false);
  });

  it('reads an on-behalf order and a missing order number', () => {
    const a = parseOrderPlaceAnswer(
      placeAnswer(
        true,
        summary({
          orderNumber: null,
          orderLabel: null,
          requestedFor: { name: 'Maria', email: 'maria@example.org' },
        }),
      ),
    );
    expect(a.replay).toBe(true);
    expect(a.order.orderNumber).toBeNull();
    expect(a.order.requestedFor).toEqual({
      self: false,
      name: 'Maria',
      email: 'maria@example.org',
    });
  });

  it.each([
    'id',
    'orderNumber',
    'orderLabel',
    'status',
    'warehouseId',
    'fulfillmentType',
    'deliveryCharterId',
    'neededBy',
    'lineCount',
    'unitCount',
    'createdAt',
    'requestedFor',
  ])('refuses an order with no %s', (field) => {
    const order = summary();
    delete order[field];
    expect(() => parseOrderPlaceAnswer(placeAnswer(false, order))).toThrow(OrderAnswerShapeError);
  });

  it('refuses a wrong shape at every level', () => {
    expect(() => parseOrderPlaceAnswer(null)).toThrow(OrderAnswerShapeError);
    expect(() => parseOrderPlaceAnswer({ result: { replay: false, order: summary() } })).toThrow(
      /organizationId/,
    );
    expect(() => parseOrderPlaceAnswer({ organizationId: ORG })).toThrow(/result/);
    expect(() =>
      parseOrderPlaceAnswer({ organizationId: ORG, result: { order: summary() } }),
    ).toThrow(/replay/);
    expect(() => parseOrderPlaceAnswer(placeAnswer(false, summary({ lineCount: 0 })))).toThrow(
      /lineCount/,
    );
    expect(() =>
      parseOrderPlaceAnswer(placeAnswer(false, summary({ fulfillmentType: 'ship' }))),
    ).toThrow(/fulfillmentType/);
    expect(() =>
      parseOrderPlaceAnswer(placeAnswer(false, summary({ requestedFor: { name: 'Maria' } }))),
    ).toThrow(/email/);
  });
});

describe('parseOrderSubmissionStatus', () => {
  it('reads each outcome, and ignores keys it does not know', () => {
    expect(parseOrderSubmissionStatus({ organizationId: ORG, outcome: 'none', x: 1 })).toEqual({
      organizationId: ORG,
      outcome: 'none',
    });
    expect(parseOrderSubmissionStatus({ organizationId: ORG, outcome: 'withdrawn' })).toEqual({
      organizationId: ORG,
      outcome: 'withdrawn',
    });
    const placed = parseOrderSubmissionStatus({
      organizationId: ORG,
      outcome: 'placed',
      order: summary(),
    });
    expect(placed.outcome === 'placed' && placed.order.id).toBe(ORDER_ID);
    const refused = parseOrderSubmissionStatus({
      organizationId: ORG,
      outcome: 'refused',
      refusal: { reason: 'item_not_orderable', detail: { [ITEM_A]: 'archived' } },
    });
    expect(refused).toEqual({
      organizationId: ORG,
      outcome: 'refused',
      refusal: { reason: 'item_not_orderable', detail: { [ITEM_A]: 'archived' } },
    });
  });

  it('refuses each missing field', () => {
    expect(() => parseOrderSubmissionStatus({ outcome: 'none' })).toThrow(/organizationId/);
    expect(() => parseOrderSubmissionStatus({ organizationId: ORG })).toThrow(/outcome/);
    expect(() => parseOrderSubmissionStatus({ organizationId: ORG, outcome: 'maybe' })).toThrow(
      /outcome/,
    );
    expect(() => parseOrderSubmissionStatus({ organizationId: ORG, outcome: 'placed' })).toThrow(
      /order/,
    );
    expect(() => parseOrderSubmissionStatus({ organizationId: ORG, outcome: 'refused' })).toThrow(
      /refusal/,
    );
    expect(() =>
      parseOrderSubmissionStatus({
        organizationId: ORG,
        outcome: 'refused',
        refusal: { detail: null },
      }),
    ).toThrow(/reason/);
  });
});

// ── What an answer means (plan 3.4's table) ─────────────────────────────────

/**
 * The phone's error, as apps/mobile/src/lib/api.ts builds it: the message to
 * show, the HTTP status, the body's `error` as `code`, and its `details`.
 * Core cannot import the app, so the class is restated here with the same
 * constructor; the web's errors reach the classifier as plain
 * `{ status, code, details }` objects, which are checked too.
 */
class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const thrown = (error: unknown): OrderCallResult => ({ ok: false, error });
const answered = (status: number, b: unknown): OrderCallResult => ({ ok: true, status, body: b });
const refused = (status: number, code: string, details?: Record<string, unknown>) =>
  thrown(new ApiError('Refused.', status, code, details));

describe('classifyOrderSubmitResult: final outcomes', () => {
  it('201: placed', () => {
    const o = classifyOrderSubmitResult(answered(201, placeAnswer(false)), { sends: 1 });
    expect(o).toMatchObject({ final: true, outcome: 'placed', replay: false, organizationId: ORG });
  });

  it('200 with replay: placed (the first answer, nothing written now), on any send', () => {
    for (const sends of [1, 2, 5]) {
      expect(classifyOrderSubmitResult(answered(200, placeAnswer(true)), { sends })).toMatchObject({
        final: true,
        outcome: 'placed',
        replay: true,
      });
    }
  });

  it('4xx with details.settled: refused and recorded, on any send', () => {
    const cases: Array<[number, string, string]> = [
      [403, 'module_disabled', 'module_disabled'],
      [403, 'forbidden', 'permission'],
      [403, 'forbidden', 'on_behalf_not_permitted'],
      [404, 'not_found', 'warehouse_not_available'],
      [400, 'validation_error', 'needed_by_past'],
      [400, 'validation_error', 'needed_by_out_of_range'],
      [400, 'validation_error', 'site_not_available'],
      [400, 'validation_error', 'item_not_orderable'],
      [400, 'validation_error', 'invalid'],
    ];
    for (const [status, code, reason] of cases) {
      for (const sends of [1, 3]) {
        const o = classifyOrderSubmitResult(
          refused(status, code, { reason, settled: true, replay: sends > 1 }),
          { sends },
        );
        expect(o, `${reason} ${sends}`).toMatchObject({
          final: true,
          outcome: 'refused',
          reason,
          recorded: true,
        });
      }
    }
  });

  it('409 submission_withdrawn: withdrawn, on any send', () => {
    for (const sends of [1, 2]) {
      expect(
        classifyOrderSubmitResult(
          refused(409, 'conflict', { reason: 'submission_withdrawn', settled: true }),
          { sends },
        ),
      ).toEqual({ final: true, outcome: 'withdrawn' });
    }
  });

  it('any other 4xx to the ONLY send: refused, nothing placed', () => {
    const cases: Array<[number, string, Record<string, unknown> | undefined, string]> = [
      [401, 'unauthenticated', undefined, 'unauthenticated'],
      [403, 'forbidden', { reason: 'aal2_required' }, 'aal2_required'],
      [403, 'forbidden', { reason: 'mfa_required' }, 'mfa_required'],
      [403, 'module_disabled', { reason: 'module_disabled' }, 'module_disabled'],
      [403, 'forbidden', { reason: 'permission' }, 'permission'],
      [403, 'forbidden', { reason: 'placer_mismatch' }, 'placer_mismatch'],
      [400, 'validation_error', { reason: 'too_many_lines' }, 'too_many_lines'],
      [400, 'validation_error', { reason: 'invalid', field: 'idempotencyKey' }, 'invalid'],
      [409, 'conflict', { reason: 'timezone_unreadable', retryable: true }, 'timezone_unreadable'],
    ];
    for (const [status, code, details, reason] of cases) {
      const o = classifyOrderSubmitResult(refused(status, code, details), { sends: 1 });
      expect(o, reason).toMatchObject({ final: true, outcome: 'refused', reason, recorded: false });
    }
  });

  it('a 404 that is not our JSON, on the only send: refused as unavailable', () => {
    const notOurs = thrown(new ApiError('That is not available on this version of the app.', 404));
    expect(classifyOrderSubmitResult(notOurs, { sends: 1 })).toMatchObject({
      final: true,
      outcome: 'refused',
      reason: 'unavailable',
      recorded: false,
    });
  });
});

describe('classifyOrderSubmitResult: the key stays live', () => {
  it('a refusal to a RESEND, raised before the key, never unlocks', () => {
    const cases: Array<[number, string, Record<string, unknown> | undefined, string]> = [
      [401, 'unauthenticated', undefined, 'unauthenticated'],
      [403, 'forbidden', { reason: 'aal2_required' }, 'aal2_required'],
      [403, 'forbidden', { reason: 'mfa_required' }, 'mfa_required'],
      [403, 'module_disabled', { reason: 'module_disabled' }, 'module_disabled'],
      [403, 'forbidden', { reason: 'permission' }, 'permission'],
      [403, 'forbidden', { reason: 'placer_mismatch' }, 'placer_mismatch'],
      [400, 'validation_error', { reason: 'notes_too_long' }, 'notes_too_long'],
      [409, 'conflict', { reason: 'timezone_unreadable', retryable: true }, 'timezone_unreadable'],
    ];
    for (const [status, code, details, reason] of cases) {
      for (const sends of [2, 3, 10]) {
        const o = classifyOrderSubmitResult(refused(status, code, details), { sends });
        expect(o, `${reason} ${sends}`).toMatchObject({ final: false, why: 'refused', reason });
      }
    }
  });

  it('409 busy, 409 idempotency_conflict, 429 and 5xx, on any send', () => {
    for (const sends of [1, 2]) {
      expect(
        classifyOrderSubmitResult(refused(409, 'conflict', { reason: 'busy', retryable: true }), {
          sends,
        }),
      ).toMatchObject({
        final: false,
        why: 'busy',
      });
      const conflict = classifyOrderSubmitResult(
        refused(409, 'conflict', {
          reason: 'idempotency_conflict',
          orderId: ORDER_ID,
          orderNumber: 123,
        }),
        { sends },
      );
      expect(conflict).toMatchObject({ final: false, why: 'conflict' });
      expect(!conflict.final && conflict.details?.orderNumber).toBe(123);
      expect(classifyOrderSubmitResult(refused(429, 'rate_limited'), { sends })).toMatchObject({
        final: false,
        why: 'rate_limited',
      });
      for (const status of [500, 502, 503, 504]) {
        expect(
          classifyOrderSubmitResult(refused(status, 'internal_error', { reason: 'failed' }), {
            sends,
          }),
        ).toMatchObject({
          final: false,
          why: 'server_fault',
        });
      }
      expect(
        classifyOrderSubmitResult(thrown(new ApiError('The server had a problem.', 502)), {
          sends,
        }),
      ).toMatchObject({
        final: false,
        why: 'server_fault',
      });
    }
  });

  it('no status at all: a timeout, a lost connection, a session that changed, an unparsable body', () => {
    const errors = [
      new Error('The request timed out.'),
      new TypeError('Network request failed'),
      Object.assign(new Error('The session changed.'), { name: 'OutboxSessionChangedError' }),
      new SyntaxError('Unexpected token < in JSON'),
      'string thrown',
      undefined,
    ];
    for (const e of errors) {
      for (const sends of [1, 2]) {
        expect(classifyOrderSubmitResult(thrown(e), { sends })).toEqual({
          final: false,
          why: 'no_answer',
          reason: null,
          details: null,
        });
      }
    }
  });

  it('an unreadable 2xx', () => {
    for (const b of [null, {}, { organizationId: ORG, result: { replay: false } }, '<html>']) {
      expect(classifyOrderSubmitResult(answered(201, b), { sends: 1 })).toMatchObject({
        final: false,
        why: 'unreadable',
      });
    }
  });

  it('a 404 that is not our JSON, on a resend', () => {
    expect(
      classifyOrderSubmitResult(thrown(new ApiError('That is not available.', 404)), { sends: 2 }),
    ).toMatchObject({
      final: false,
      why: 'unavailable',
    });
  });

  it('only sends === 1 lets an unrecorded refusal unlock (a count that cannot be trusted is a resend)', () => {
    for (const sends of [0, -1, 1.5, Number.NaN]) {
      expect(
        classifyOrderSubmitResult(refused(403, 'forbidden', { reason: 'permission' }), { sends }),
      ).toMatchObject({ final: false });
    }
  });

  it("the web's plain error objects are read the same way", () => {
    const web = (status: number, code: string, details?: Record<string, unknown>) =>
      thrown({ status, code, details, message: 'x' });
    expect(
      classifyOrderSubmitResult(web(403, 'forbidden', { reason: 'permission' }), { sends: 1 }),
    ).toMatchObject({ final: true, outcome: 'refused' });
    expect(
      classifyOrderSubmitResult(web(403, 'forbidden', { reason: 'permission' }), { sends: 2 }),
    ).toMatchObject({ final: false, why: 'refused' });
    expect(
      classifyOrderSubmitResult(
        web(400, 'validation_error', {
          reason: 'item_not_orderable',
          settled: true,
          items: { [ITEM_A]: 'rental' },
        }),
        { sends: 2 },
      ),
    ).toMatchObject({
      final: true,
      outcome: 'refused',
      recorded: true,
    });
  });

  it("a web action's error, with the status its code gets on the API", () => {
    // services/context.ts serviceErrorStatus, restated (core cannot import
    // the web): PO-2 passes the real one.
    const statusOf = (code: string) =>
      ({
        unauthenticated: 401,
        forbidden: 403,
        module_disabled: 403,
        not_found: 404,
        validation_error: 400,
        conflict: 409,
        plan_limit_exceeded: 409,
      })[code] ?? 500;
    const fail = (code: string, details?: Record<string, unknown>) =>
      ({ ok: false, error: { code, message: 'x', ...(details ? { details } : {}) } }) as const;

    // A refusal recorded under the key is final on any send.
    const settled = fail('validation_error', {
      reason: 'item_not_orderable',
      settled: true,
      items: { [ITEM_A]: 'rental' },
    });
    for (const sends of [1, 2]) {
      expect(
        classifyOrderSubmitResult(orderCallResultFromAction(settled, statusOf), { sends }),
      ).toMatchObject({ final: true, outcome: 'refused', recorded: true });
    }
    // An unrecorded refusal: final on the only send, live on a resend.
    const permission = orderCallResultFromAction(
      fail('forbidden', { reason: 'permission' }),
      statusOf,
    );
    expect(classifyOrderSubmitResult(permission, { sends: 1 })).toMatchObject({
      final: true,
      outcome: 'refused',
      reason: 'permission',
    });
    expect(classifyOrderSubmitResult(permission, { sends: 2 })).toMatchObject({
      final: false,
      why: 'refused',
    });
    // Busy, withdrawn, a fault.
    expect(
      classifyOrderSubmitResult(
        orderCallResultFromAction(fail('conflict', { reason: 'busy', retryable: true }), statusOf),
        { sends: 1 },
      ),
    ).toMatchObject({ final: false, why: 'busy' });
    expect(
      classifyOrderSubmitResult(
        orderCallResultFromAction(
          fail('conflict', { reason: 'submission_withdrawn', settled: true }),
          statusOf,
        ),
        { sends: 2 },
      ),
    ).toEqual({ final: true, outcome: 'withdrawn' });
    expect(
      classifyOrderSubmitResult(
        orderCallResultFromAction(fail('internal_error', { reason: 'failed' }), statusOf),
        { sends: 1 },
      ),
    ).toMatchObject({ final: false, why: 'server_fault' });
    // The placed answer is the action's data.
    expect(
      classifyOrderSubmitResult(
        orderCallResultFromAction({ ok: true, data: placeAnswer(false) }, statusOf),
        { sends: 1 },
      ),
    ).toMatchObject({ final: true, outcome: 'placed', replay: false });
    // A status the function cannot give is no answer: locked, never unlocked.
    expect(
      classifyOrderSubmitResult(
        orderCallResultFromAction(fail('forbidden', { reason: 'permission' }), () => Number.NaN),
        { sends: 1 },
      ),
    ).toMatchObject({ final: false, why: 'no_answer' });
    // Handing the action's error in WITHOUT a status reads as no answer, the
    // safe side: this is why the adapter exists.
    expect(classifyOrderSubmitResult(thrown(settled.error), { sends: 1 })).toMatchObject({
      final: false,
      why: 'no_answer',
    });
  });

  it('never reads message text', () => {
    // A message that says "withdrawn", "placed" or "settled" changes nothing.
    const o = classifyOrderSubmitResult(
      thrown(new ApiError('It was withdrawn and settled and placed.', 500)),
      { sends: 1 },
    );
    expect(o).toMatchObject({ final: false, why: 'server_fault' });
    const p = classifyOrderSubmitResult(
      thrown(new ApiError('submission_withdrawn', 400, 'validation_error')),
      { sends: 2 },
    );
    expect(p).toMatchObject({ final: false, why: 'refused' });
  });
});

describe('classifyOrderSettleResult: a status read or a withdraw', () => {
  const status = (outcome: string, extra: Record<string, unknown> = {}) =>
    answered(200, { organizationId: ORG, outcome, ...extra });

  it('placed, refused and withdrawn are final', () => {
    expect(classifyOrderSettleResult(status('placed', { order: summary() }))).toMatchObject({
      final: true,
      outcome: 'placed',
      replay: true,
    });
    expect(classifyOrderSettleResult(status('withdrawn'))).toEqual({
      final: true,
      outcome: 'withdrawn',
    });
    const items = classifyOrderSettleResult(
      status('refused', {
        refusal: { reason: 'item_not_orderable', detail: { [ITEM_A]: 'archived' } },
      }),
    );
    expect(items).toMatchObject({
      final: true,
      outcome: 'refused',
      reason: 'item_not_orderable',
      recorded: true,
    });
    expect(items.final && items.outcome === 'refused' && items.details.items).toEqual({
      [ITEM_A]: 'archived',
    });
    const site = classifyOrderSettleResult(
      status('refused', { refusal: { reason: 'site_not_available', detail: 'inactive' } }),
    );
    expect(site.final && site.outcome === 'refused' && site.details.site).toBe('inactive');
  });

  it('none is not: it only says nothing has committed yet', () => {
    expect(classifyOrderSettleResult(status('none'))).toMatchObject({ final: false });
  });

  it('a refused, busy, failed or lost call is not final', () => {
    expect(classifyOrderSettleResult(refused(401, 'unauthenticated'))).toMatchObject({
      final: false,
      why: 'refused',
      reason: 'unauthenticated',
    });
    expect(classifyOrderSettleResult(refused(409, 'conflict', { reason: 'busy' }))).toMatchObject({
      final: false,
      why: 'busy',
    });
    expect(classifyOrderSettleResult(refused(429, 'rate_limited'))).toMatchObject({
      final: false,
      why: 'rate_limited',
    });
    expect(
      classifyOrderSettleResult(refused(500, 'internal_error', { reason: 'failed' })),
    ).toMatchObject({ final: false, why: 'server_fault' });
    expect(classifyOrderSettleResult(thrown(new ApiError('Not available.', 404)))).toMatchObject({
      final: false,
      why: 'unavailable',
    });
    expect(classifyOrderSettleResult(thrown(new Error('The request timed out.')))).toMatchObject({
      final: false,
      why: 'no_answer',
    });
    expect(classifyOrderSettleResult(answered(200, { outcome: 'placed' }))).toMatchObject({
      final: false,
      why: 'unreadable',
    });
  });
});

describe('orderCallResultForOrganization: an answer for another organization is never final', () => {
  const OTHER_ORG = 'ffffffff-0000-4000-8000-000000000009';

  it('a success that names this organization passes unchanged, in any case', () => {
    const ok = answered(201, placeAnswer(false));
    expect(orderCallResultForOrganization(ok, ORG)).toBe(ok);
    expect(orderCallResultForOrganization(ok, ORG.toUpperCase())).toBe(ok);
  });

  it('a success that names another organization, or none, is no answer: the key stays live', () => {
    for (const b of [{ ...placeAnswer(false), organizationId: OTHER_ORG }, { result: placeAnswer(false).result }, null]) {
      const r = orderCallResultForOrganization(answered(201, b), ORG);
      expect(classifyOrderSubmitResult(r, { sends: 1 })).toMatchObject({ final: false, why: 'no_answer' });
      expect(classifyOrderSettleResult(r)).toMatchObject({ final: false, why: 'no_answer' });
    }
  });

  it('a refusal RECORDED in another organization (a resend after a workspace switch) never settles this key', () => {
    // The reviewers' case: the first send's answer was lost, the workspace was
    // switched elsewhere, and the resend was recorded as refused in the other
    // organization, settled there.
    const recordedThere = refused(404, 'not_found', {
      reason: 'warehouse_not_available',
      settled: true,
      replay: false,
      organizationId: OTHER_ORG,
    });
    const r = orderCallResultForOrganization(recordedThere, ORG);
    expect(classifyOrderSubmitResult(r, { sends: 2 })).toMatchObject({
      final: false,
      why: 'refused',
      reason: 'organization_changed',
    });
    expect(classifyOrderSettleResult(r)).toMatchObject({
      final: false,
      why: 'refused',
      reason: 'organization_changed',
    });
    // On the ONLY send nothing reached this organization: final, never recorded here.
    expect(classifyOrderSubmitResult(r, { sends: 1 })).toMatchObject({
      final: true,
      outcome: 'refused',
      reason: 'organization_changed',
      recorded: false,
    });
  });

  it('a status or withdraw answer for another organization never settles this key', () => {
    for (const b of [
      { organizationId: OTHER_ORG, outcome: 'withdrawn' },
      { organizationId: OTHER_ORG, outcome: 'refused', refusal: { reason: 'permission', detail: null } },
      { organizationId: OTHER_ORG, outcome: 'placed', order: summary() },
    ]) {
      expect(classifyOrderSettleResult(orderCallResultForOrganization(answered(200, b), ORG))).toMatchObject({
        final: false,
      });
    }
  });

  it("the server's own organization_changed refusal is never final on a resend or a settle call", () => {
    const r = orderCallResultForOrganization(
      refused(409, 'conflict', { reason: 'organization_changed', organizationId: OTHER_ORG }),
      ORG,
    );
    expect(classifyOrderSubmitResult(r, { sends: 3 })).toMatchObject({ final: false, reason: 'organization_changed' });
    expect(classifyOrderSettleResult(r)).toMatchObject({ final: false, reason: 'organization_changed' });
  });

  it('a refusal that names this organization, or no organization, is classified as it is', () => {
    const here = refused(404, 'not_found', {
      reason: 'warehouse_not_available',
      settled: true,
      organizationId: ORG.toUpperCase(),
    });
    expect(orderCallResultForOrganization(here, ORG)).toBe(here);
    expect(classifyOrderSubmitResult(orderCallResultForOrganization(here, ORG), { sends: 2 })).toMatchObject({
      final: true,
      outcome: 'refused',
      recorded: true,
    });
    const unnamed = refused(401, 'unauthenticated');
    expect(orderCallResultForOrganization(unnamed, ORG)).toBe(unnamed);
    const lostCall = thrown(new Error('The request timed out.'));
    expect(orderCallResultForOrganization(lostCall, ORG)).toBe(lostCall);
  });

  it('a fault answered by another organization stays a fault (its outcome is unknown)', () => {
    const r = orderCallResultForOrganization(
      refused(500, 'internal_error', { reason: 'failed', organizationId: OTHER_ORG }),
      ORG,
    );
    expect(classifyOrderSubmitResult(r, { sends: 1 })).toMatchObject({ final: false, why: 'server_fault' });
  });
});

// ── The state machine ───────────────────────────────────────────────────────

const AT = '2026-10-03T16:00:00.000Z';
const BODY = body() as unknown as OrderCreateRequestInput;

function run(
  events: OrderSubmissionEvent[],
  from: OrderSubmissionState = ORDER_SUBMISSION_OPEN,
): OrderSubmissionState {
  return events.reduce(orderSubmissionReducer, from);
}

const send: OrderSubmissionEvent = { type: 'send', key: KEY, body: BODY, at: AT };
const result = (r: OrderCallResult): OrderSubmissionEvent => ({ type: 'send-result', result: r });
const lost = result(thrown(new Error('The request timed out.')));

describe('orderSubmission: the cart unlocks only on a final outcome', () => {
  it('a send is written ahead, already counting itself, and locks', () => {
    const s = run([send]);
    expect(s.phase).toBe('sending');
    expect(orderSubmissionLocked(s)).toBe(true);
    expect(pendingOrderSubmissionOf(s)).toEqual({
      key: KEY,
      body: BODY,
      state: 'possibly_sent',
      sends: 1,
      firstSentAt: AT,
    });
  });

  it('placed: the success screen, then open; the record is dropped', () => {
    const s = run([send, result(answered(201, placeAnswer(false)))]);
    expect(s).toMatchObject({ phase: 'placed', replay: false, viaWithdraw: false });
    expect(orderSubmissionLocked(s)).toBe(false);
    expect(pendingOrderSubmissionOf(s)).toBeNull();
    expect(run([{ type: 'dismiss' }], s)).toEqual(ORDER_SUBMISSION_OPEN);
  });

  it('a lost answer locks, and Check and finish resends the same key and body, counting it', () => {
    const s = run([send, lost]);
    expect(s).toMatchObject({ phase: 'unconfirmed', last: { why: 'no_answer' } });
    expect(orderSubmissionLocked(s)).toBe(true);
    const again = run([{ type: 'resend' }], s);
    expect(again.phase).toBe('sending');
    expect(pendingOrderSubmissionOf(again)).toEqual({
      key: KEY,
      body: BODY,
      state: 'possibly_sent',
      sends: 2,
      firstSentAt: AT,
    });
    const done = run([result(answered(200, placeAnswer(true)))], again);
    expect(done).toMatchObject({ phase: 'placed', replay: true });
  });

  it('a refusal to the only send unlocks; the same refusal to a resend stays locked', () => {
    const first = run([send, result(refused(403, 'forbidden', { reason: 'permission' }))]);
    expect(first).toMatchObject({ phase: 'refused', reason: 'permission', recorded: false });
    expect(orderSubmissionLocked(first)).toBe(false);

    const resend = run([
      send,
      lost,
      { type: 'resend' },
      result(refused(403, 'forbidden', { reason: 'permission' })),
    ]);
    expect(resend).toMatchObject({
      phase: 'unconfirmed',
      last: { why: 'refused', reason: 'permission' },
    });
    expect(orderSubmissionLocked(resend)).toBe(true);
    expect(pendingOrderSubmissionOf(resend)?.sends).toBe(2);
  });

  it("a refused resend is settled only by Don't send it", () => {
    const locked = run([send, lost, { type: 'resend' }, result(refused(401, 'unauthenticated'))]);
    // A status read answering none changes nothing.
    const afterRead = run(
      [{ type: 'status-result', result: answered(200, { organizationId: ORG, outcome: 'none' }) }],
      locked,
    );
    expect(afterRead).toBe(locked);
    const withdrawing = run([{ type: 'withdraw' }], locked);
    expect(withdrawing.phase).toBe('withdrawing');
    expect(orderSubmissionLocked(withdrawing)).toBe(true);
    expect(pendingOrderSubmissionOf(withdrawing)?.sends).toBe(2); // a withdraw is not a send
    const withdrawn = run(
      [
        {
          type: 'withdraw-result',
          result: answered(200, { organizationId: ORG, outcome: 'withdrawn' }),
        },
      ],
      withdrawing,
    );
    expect(withdrawn).toEqual({ phase: 'withdrawn' });
    expect(orderSubmissionLocked(withdrawn)).toBe(false);
    expect(run([{ type: 'dismiss' }], withdrawn)).toEqual(ORDER_SUBMISSION_OPEN);
  });

  it("Don't send it can find the order already placed", () => {
    const s = run([
      send,
      lost,
      { type: 'withdraw' },
      {
        type: 'withdraw-result',
        result: answered(200, { organizationId: ORG, outcome: 'placed', order: summary() }),
      },
    ]);
    expect(s).toMatchObject({ phase: 'placed', viaWithdraw: true });
  });

  it("a Don't send it that fails leaves the key live, with why", () => {
    const s = run([
      send,
      lost,
      { type: 'withdraw' },
      { type: 'withdraw-result', result: refused(409, 'conflict', { reason: 'busy' }) },
    ]);
    expect(s).toMatchObject({ phase: 'unconfirmed', last: { why: 'busy' } });
    expect(orderSubmissionLocked(s)).toBe(true);
  });

  it('a status read: none never unlocks, a settled answer does', () => {
    const locked = run([send, lost]);
    for (const r of [
      answered(200, { organizationId: ORG, outcome: 'none' }),
      refused(401, 'unauthenticated'),
      thrown(new Error('The request timed out.')),
      answered(200, '<html>'),
    ]) {
      expect(run([{ type: 'status-result', result: r }], locked)).toBe(locked);
    }
    expect(
      run(
        [
          {
            type: 'status-result',
            result: answered(200, { organizationId: ORG, outcome: 'placed', order: summary() }),
          },
        ],
        locked,
      ),
    ).toMatchObject({
      phase: 'placed',
    });
    expect(
      run(
        [
          {
            type: 'status-result',
            result: answered(200, {
              organizationId: ORG,
              outcome: 'refused',
              refusal: { reason: 'needed_by_past', detail: null },
            }),
          },
        ],
        locked,
      ),
    ).toMatchObject({ phase: 'refused', reason: 'needed_by_past', recorded: true });
  });

  it('a recorded refusal on a resend is final; withdrawn on a resend is final', () => {
    expect(
      run([
        send,
        lost,
        { type: 'resend' },
        result(
          refused(400, 'validation_error', {
            reason: 'item_not_orderable',
            settled: true,
            replay: true,
          }),
        ),
      ]),
    ).toMatchObject({ phase: 'refused', recorded: true });
    expect(
      run([
        send,
        lost,
        { type: 'resend' },
        result(refused(409, 'conflict', { reason: 'submission_withdrawn', settled: true })),
      ]),
    ).toEqual({ phase: 'withdrawn' });
  });

  it('busy, conflict, 429 and 5xx keep the key live', () => {
    for (const r of [
      refused(409, 'conflict', { reason: 'busy' }),
      refused(409, 'conflict', { reason: 'idempotency_conflict' }),
      refused(429, 'rate_limited'),
      refused(500, 'internal_error', { reason: 'failed' }),
      answered(201, { nope: true }),
    ]) {
      const s = run([send, result(r)]);
      expect(s.phase).toBe('unconfirmed');
      expect(orderSubmissionLocked(s)).toBe(true);
    }
  });

  it('a relaunch with a pending record reads as unconfirmed', () => {
    const pending: PendingOrderSubmission = {
      key: KEY,
      body: BODY,
      state: 'possibly_sent',
      sends: 1,
      firstSentAt: AT,
    };
    const s = run([{ type: 'restore', pending }]);
    expect(s).toMatchObject({ phase: 'unconfirmed', pending, last: { why: 'no_answer' } });
    expect(orderSubmissionLocked(s)).toBe(true);
  });

  it('events that do not fit change nothing: a second tap, a new key while one is live, a late answer', () => {
    const sending = run([send]);
    expect(run([{ type: 'send', key: OTHER_USER, body: BODY, at: AT }], sending)).toBe(sending);
    expect(run([{ type: 'resend' }], sending)).toBe(sending);
    expect(run([{ type: 'withdraw' }], sending)).toBe(sending);
    expect(
      run(
        [
          {
            type: 'status-result',
            result: answered(200, { organizationId: ORG, outcome: 'withdrawn' }),
          },
        ],
        sending,
      ),
    ).toBe(sending);
    const locked = run([send, lost]);
    expect(run([{ type: 'send', key: OTHER_USER, body: BODY, at: AT }], locked)).toBe(locked);
    expect(run([result(answered(201, placeAnswer(false)))], locked)).toBe(locked);
    expect(run([{ type: 'dismiss' }], locked)).toBe(locked);
    expect(
      run(
        [
          {
            type: 'restore',
            pending: {
              key: OTHER_USER,
              body: BODY,
              state: 'possibly_sent',
              sends: 1,
              firstSentAt: AT,
            },
          },
        ],
        locked,
      ),
    ).toBe(locked);
    expect(run([{ type: 'send-result', result: answered(201, placeAnswer(false)) }])).toEqual(
      ORDER_SUBMISSION_OPEN,
    );
  });

  it('the key tracked is the key in the body: a send or a restore that disagrees changes nothing', () => {
    // The server places under the body's key; the status read and Don't send
    // it use the tracked key. If they differed, a withdraw could settle the
    // wrong key as "not sent" while the body's key placed the order.
    const mismatched = { ...BODY, idempotencyKey: OTHER_USER } as OrderCreateRequestInput;
    expect(run([{ type: 'send', key: KEY, body: mismatched, at: AT }])).toBe(ORDER_SUBMISSION_OPEN);
    expect(
      run([
        {
          type: 'restore',
          pending: {
            key: KEY,
            body: mismatched,
            state: 'possibly_sent',
            sends: 1,
            firstSentAt: AT,
          },
        },
      ]),
    ).toBe(ORDER_SUBMISSION_OPEN);
    expect(run([send]).phase).toBe('sending');
  });

  it('a send or a withdraw happens only on a tap: no answer ever produces one', () => {
    // Every transition out of an answer lands in a state with no call out.
    const answers: OrderCallResult[] = [
      answered(201, placeAnswer(false)),
      refused(403, 'forbidden', { reason: 'permission' }),
      refused(409, 'conflict', { reason: 'busy' }),
      thrown(new Error('timeout')),
    ];
    for (const r of answers) {
      const s = run([send, result(r)]);
      expect(['placed', 'refused', 'withdrawn', 'unconfirmed']).toContain(s.phase);
    }
  });
});

describe('refuseAddWhileLocked', () => {
  it('refuses an add from outside the cart while a key is live, and points to the panel', () => {
    const pending = pendingOrderSubmissionOf(run([send, lost]));
    expect(refuseAddWhileLocked(pending)).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    expect(ORDER_ADD_WHILE_LOCKED_COPY).toMatch(/Check and finish/);
    expect(ORDER_ADD_WHILE_LOCKED_COPY).toMatch(/Don't send it/);
  });

  it('lets it through when the cart is free', () => {
    expect(refuseAddWhileLocked(null)).toBeNull();
    expect(refuseAddWhileLocked(undefined)).toBeNull();
    expect(
      refuseAddWhileLocked(
        pendingOrderSubmissionOf(run([send, result(answered(201, placeAnswer(false)))])),
      ),
    ).toBeNull();
  });
});

describe('parsePendingOrderSubmission (the stored record)', () => {
  const stored = { key: KEY, body: body(), state: 'possibly_sent', sends: 2, firstSentAt: AT };

  it('reads the signed-in user’s own record', () => {
    expect(parsePendingOrderSubmission(JSON.parse(JSON.stringify(stored)), PLACER)).toEqual(stored);
    expect(parsePendingOrderSubmission(stored, PLACER.toUpperCase())).toEqual(stored);
  });

  it('never hands one account’s record to another (judge X-1)', () => {
    expect(parsePendingOrderSubmission(stored, OTHER_USER)).toBeNull();
  });

  it('drops a record it cannot read, or cannot tie to this account and this key', () => {
    expect(parsePendingOrderSubmission(null, PLACER)).toBeNull();
    expect(parsePendingOrderSubmission({ ...stored, state: 'sent' }, PLACER)).toBeNull();
    expect(parsePendingOrderSubmission({ ...stored, key: 'k' }, PLACER)).toBeNull();
    expect(parsePendingOrderSubmission({ ...stored, sends: 0 }, PLACER)).toBeNull();
    expect(parsePendingOrderSubmission({ ...stored, firstSentAt: '' }, PLACER)).toBeNull();
    // The key in the body must be the record's key.
    expect(parsePendingOrderSubmission({ ...stored, key: OTHER_USER }, PLACER)).toBeNull();
    // No body, or a body that names no placer: nothing ties it to this account.
    expect(parsePendingOrderSubmission({ ...stored, body: null }, PLACER)).toBeNull();
    expect(parsePendingOrderSubmission({ ...stored, body: [body()] }, PLACER)).toBeNull();
    const noPlacer = body();
    delete noPlacer.placerUserId;
    expect(parsePendingOrderSubmission({ ...stored, body: noPlacer }, PLACER)).toBeNull();
    expect(
      parsePendingOrderSubmission({ ...stored, body: body({ placerUserId: 42 }) }, PLACER),
    ).toBeNull();
  });

  describe("a record of this account whose body today's schema no longer reads", () => {
    // Written by an earlier build (a cap tightened, a field changed) before an
    // answer was lost. The key may have placed an order: settle, never guess.
    const staleBody = { ...body(), lines: [], requesterPhone: null };
    const stale = { ...stored, body: staleBody };

    it('is kept, flagged, not dropped', () => {
      const p = parsePendingOrderSubmission(stale, PLACER);
      expect(p).toEqual({ ...stale, bodyUnreadable: true });
      expect(parsePendingOrderSubmission(stale, PLACER.toUpperCase())).not.toBeNull();
    });

    it('still belongs to its account only, and to its key only', () => {
      expect(parsePendingOrderSubmission(stale, OTHER_USER)).toBeNull();
      expect(parsePendingOrderSubmission({ ...stale, key: OTHER_USER }, PLACER)).toBeNull();
      expect(
        parsePendingOrderSubmission(
          { ...stale, body: { ...staleBody, idempotencyKey: 'shortfall-1' } },
          PLACER,
        ),
      ).toBeNull();
    });

    it("stays locked: a status read or Don't send it settles it, Check and finish is not offered", () => {
      const p = parsePendingOrderSubmission(stale, PLACER)!;
      const s = run([{ type: 'restore', pending: p }]);
      expect(s.phase).toBe('unconfirmed');
      expect(orderSubmissionLocked(s)).toBe(true);
      expect(orderSubmissionCanResend(s)).toBe(false);
      expect(run([{ type: 'resend' }], s)).toBe(s);
      expect(refuseAddWhileLocked(pendingOrderSubmissionOf(s))).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
      expect(
        run(
          [
            {
              type: 'status-result',
              result: answered(200, { organizationId: ORG, outcome: 'none' }),
            },
          ],
          s,
        ),
      ).toBe(s);
      expect(
        run(
          [
            {
              type: 'status-result',
              result: answered(200, { organizationId: ORG, outcome: 'placed', order: summary() }),
            },
          ],
          s,
        ),
      ).toMatchObject({ phase: 'placed' });
      const withdrawing = run([{ type: 'withdraw' }], s);
      expect(withdrawing.phase).toBe('withdrawing');
      expect(
        run(
          [
            {
              type: 'withdraw-result',
              result: answered(200, { organizationId: ORG, outcome: 'withdrawn' }),
            },
          ],
          withdrawing,
        ),
      ).toEqual({ phase: 'withdrawn' });
      // A readable record can be resent.
      const fine = run([
        { type: 'restore', pending: parsePendingOrderSubmission(stored, PLACER)! },
      ]);
      expect(orderSubmissionCanResend(fine)).toBe(true);
      expect(orderSubmissionCanResend(run([send]))).toBe(false);
    });

    it('the flag is worked out on every read, never trusted from storage', () => {
      // Pattern #9: a stored flag must not stick once the body reads again.
      const p = parsePendingOrderSubmission({ ...stored, bodyUnreadable: true }, PLACER);
      expect(p).toEqual(stored);
      expect(p && 'bodyUnreadable' in p).toBe(false);
    });

    it('the panel says why it cannot be sent again, and what settles it', () => {
      const ctx = { surface: 'web' as const, bodyUnreadable: true };
      const last = {
        final: false as const,
        why: 'no_answer' as const,
        reason: null,
        details: null,
      };
      expect(orderUnconfirmedCopy(last, ctx)).toBe(ORDER_UNCONFIRMED_STALE_BODY_COPY);
      expect(orderUnconfirmedCopy({ ...last, why: 'busy' }, ctx)).toBe(
        ORDER_UNCONFIRMED_STALE_BODY_COPY,
      );
      expect(ORDER_UNCONFIRMED_STALE_BODY_COPY).not.toMatch(/Check and finish/);
      expect(ORDER_UNCONFIRMED_STALE_BODY_COPY).toMatch(/Don't send it/);
      expect(
        orderUnconfirmedCopy({ ...last, why: 'refused', reason: 'unauthenticated' }, ctx),
      ).toBe(ORDER_SIGN_IN_COPY);
    });
  });
});

// ── Details and words ───────────────────────────────────────────────────────

describe('readOrderRefusalDetails', () => {
  it('reads only what it knows, by type', () => {
    expect(
      readOrderRefusalDetails({
        reason: 'x',
        settled: 'yes',
        items: { a: 'rental', b: 3 },
        orderNumber: '12',
      }),
    ).toEqual({
      reason: 'x',
      field: null,
      settled: false,
      replay: false,
      retryable: false,
      items: { a: 'rental' },
      site: null,
      orderId: null,
      orderNumber: null,
    });
  });
});

describe('the words', () => {
  const ctx = {
    surface: 'phone' as const,
    warehouseName: 'DC4',
    itemName: (id: string) => ({ [ITEM_A]: 'Backpack', [ITEM_B]: 'Mug' })[id] ?? null,
  };
  const d = (patch: Record<string, unknown>) => readOrderRefusalDetails(patch);

  it('each reason says what to do, from section 6', () => {
    expect(orderRefusalCopy('on_behalf_not_permitted', null, ctx)).toBe(
      ORDER_ON_BEHALF_NOT_PERMITTED_COPY,
    );
    expect(orderRefusalCopy('warehouse_not_available', null, ctx)).toBe(
      "You can't order from this warehouse. Choose another one.",
    );
    expect(orderRefusalCopy('module_disabled', null, ctx)).toBe(
      'Ordering is turned off for your organization.',
    );
    expect(orderRefusalCopy('permission', null, ctx)).toBe(
      "Your account can't place orders. Ask an admin.",
    );
    expect(orderRefusalCopy('needed_by_past', null, ctx)).toBe(NEEDED_BY_IN_PAST_COPY);
    expect(orderRefusalCopy('needed_by_out_of_range', null, ctx)).toBe(NEEDED_BY_OUT_OF_RANGE_COPY);
    expect(orderRefusalCopy('placer_mismatch', null, ctx)).toBe(
      "This order request was started by a different account, so it wasn't sent.",
    );
    expect(orderRefusalCopy('site_not_available', d({ site: 'not_serviced' }), ctx)).toBe(
      "DC4 doesn't deliver to that site anymore. Choose another site.",
    );
    expect(orderRefusalCopy('site_not_available', d({ site: 'inactive' }), ctx)).toBe(
      ORDER_SITE_INACTIVE_COPY,
    );
    expect(orderRefusalCopy('unauthenticated', null, ctx)).toBe(ORDER_SIGN_IN_COPY);
    expect(orderRefusalCopy('failed', null, ctx)).toBe(ORDER_FAULT_COPY);
    expect(orderRefusalCopy(null, null, ctx)).toBe(ORDER_REFUSED_FINAL_COPY);
    expect(orderRefusalCopy('submission_withdrawn', null, ctx)).toBe(ORDER_WITHDRAWN_COPY);
    expect(orderRefusalCopy('unavailable', null, ctx)).toBe(ORDER_PHONE_UNAVAILABLE_COPY);
    expect(orderRefusalCopy('invalid', d({ field: 'lines' }), ctx)).toBe(ORDER_LINES_EMPTY_COPY);
    expect(orderRefusalCopy('too_many_units', null, ctx)).toBe(
      'An order request can have at most 10,000 units.',
    );
    expect(orderRefusalCopy('aal2_required', null, { ...ctx, surface: 'web' })).toMatch(
      /authenticator app/,
    );
  });

  it('a workspace switch, another account and an out-of-date page each say how to finish (review round 1)', () => {
    const last = (reason: string) => ({ final: false as const, why: 'refused' as const, reason, details: d({ reason }) });
    // Final (the only send, nothing placed): what happened and what to do, never Check and finish.
    expect(orderRefusalCopy('organization_changed', null, ctx)).toBe(ORDER_ORGANIZATION_CHANGED_COPY);
    expect(orderRefusalCopy('page_out_of_date', null, ctx)).toBe(ORDER_PAGE_OUT_OF_DATE_FINAL_COPY);
    // The key is live: the panel says what settles it, alone (Check and finish
    // and Don't send it answer the same until then, so no suffix offers them).
    for (const surfaceCtx of [ctx, { ...ctx, surface: 'web' as const }, { ...ctx, bodyUnreadable: true }]) {
      expect(orderUnconfirmedCopy(last('organization_changed'), surfaceCtx)).toBe(
        ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
      );
      expect(orderUnconfirmedCopy(last('placer_mismatch'), surfaceCtx)).toBe(
        ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
      );
      expect(orderUnconfirmedCopy(last('page_out_of_date'), surfaceCtx)).toBe(ORDER_PAGE_OUT_OF_DATE_COPY);
    }
    for (const text of [
      ORDER_ORGANIZATION_CHANGED_COPY,
      ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
      ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
      ORDER_PAGE_OUT_OF_DATE_COPY,
      ORDER_PAGE_OUT_OF_DATE_FINAL_COPY,
    ]) {
      expect(text).not.toMatch(/try again/i);
      expect(text).not.toMatch(/Check and finish/);
    }
  });

  it('names refused items from the cart, never from the server', () => {
    const items = d({
      items: { [ITEM_A]: 'archived', [ITEM_B]: 'rental', [OTHER_USER]: 'not_visible' },
    });
    expect(orderRefusalCopy('item_not_orderable', items, ctx)).toBe(
      "Some items can't be ordered from here anymore: Backpack, Mug. Remove them to continue.",
    );
    expect(
      orderRefusalCopy('item_not_orderable', d({ items: { [OTHER_USER]: 'not_visible' } }), ctx),
    ).toBe("Some items can't be ordered from here anymore. Remove them to continue.");
    expect(orderItemRefusalCopy('archived', 'Backpack')).toBe('This item was archived.');
    expect(orderItemRefusalCopy('not_visible', 'Backpack')).toBe(
      "This item isn't available to you here.",
    );
    expect(orderItemRefusalCopy('deleted', 'Backpack')).toBe(
      "This item isn't available to you here.",
    );
    expect(orderItemRefusalCopy('other_warehouse', 'Backpack')).toBe(
      "This item isn't available to you here.",
    );
  });

  it("the rental, receipt and kit sentences are the web service's own (until PO-2 points it here)", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const service = readFileSync(
      path.join(root, 'apps/web/src/server/services/order-requests.ts'),
      'utf8',
    );
    expect(service).toContain(
      '`${name} is a rental item. Check it out from Rentals instead of ordering it.`',
    );
    expect(service).toContain(
      "`${name} is a pre-assembled kit and can't be put on an order. Order the kit's items instead.`",
    );
    expect(service).toContain(
      "`This item hasn't been received yet: ${it.name}. It can be ordered once its first stock arrives.`",
    );
    expect(orderItemRefusalCopy('rental', 'Projector')).toBe(
      'Projector is a rental item. Check it out from Rentals instead of ordering it.',
    );
    expect(orderItemRefusalCopy('kit_stock', 'Kit')).toBe(
      "Kit is a pre-assembled kit and can't be put on an order. Order the kit's items instead.",
    );
    expect(orderItemRefusalCopy('awaiting_first_receipt', 'Mug')).toBe(
      "This item hasn't been received yet: Mug. It can be ordered once its first stock arrives.",
    );
  });

  it('the unconfirmed panel says why the key is still live', () => {
    const nf = (why: string, reason: string | null = null) =>
      ({ final: false, why, reason, details: null }) as Parameters<typeof orderUnconfirmedCopy>[0];
    expect(orderUnconfirmedCopy(nf('no_answer'), ctx)).toBe(ORDER_UNCONFIRMED_BODY_COPY);
    expect(orderUnconfirmedCopy(nf('busy'), ctx)).toBe(ORDER_BUSY_COPY);
    expect(orderUnconfirmedCopy(nf('rate_limited'), ctx)).toBe(ORDER_RATE_LIMITED_COPY);
    expect(orderUnconfirmedCopy(nf('conflict'), ctx)).toBe(ORDER_CONFLICT_COPY);
    expect(orderUnconfirmedCopy(nf('server_fault'), ctx)).toBe(ORDER_FAULT_COPY);
    expect(orderUnconfirmedCopy(nf('unreadable'), ctx)).toBe(ORDER_FAULT_COPY);
    expect(orderUnconfirmedCopy(nf('refused', 'unauthenticated'), ctx)).toBe(ORDER_SIGN_IN_COPY);
    expect(orderUnconfirmedCopy(nf('refused', 'aal2_required'), ctx)).toBe(
      ORDER_PHONE_AAL2_UNCONFIRMED_COPY,
    );
    expect(orderUnconfirmedCopy(nf('refused', 'permission'), ctx)).toBe(
      `Your account can't place orders. Ask an admin. ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`,
    );
    expect(orderUnconfirmedCopy(nf('unavailable', 'unavailable'), ctx)).toBe(
      `${ORDER_PHONE_UNAVAILABLE_COPY} ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`,
    );
  });

  it("a final refusal core has no reason for says it wasn't sent, never Check and finish", () => {
    // Refused on the only send, so nothing was placed and the cart is
    // unlocked: there is no Check and finish button to point at.
    const answers: OrderCallResult[] = [
      thrown(new ApiError('Forbidden', 403)), // the edge's HTML 403
      thrown(new ApiError('Payload too large', 413)), // an HTML 413
      refused(400, 'validation_error'), // a route 400 with no details.reason
      refused(404, 'not_found'), // our JSON, no reason
      refused(422, 'unprocessable', { reason: 'something_new' }),
    ];
    for (const r of answers) {
      const o = classifyOrderSubmitResult(r, { sends: 1 });
      expect(o).toMatchObject({ final: true, outcome: 'refused', recorded: false });
      if (!o.final || o.outcome !== 'refused') continue;
      const words = orderRefusalCopy(o.reason, o.details, ctx);
      expect(words, o.reason).toBe(ORDER_REFUSED_FINAL_COPY);
      expect(words).not.toMatch(/Check and finish/);
    }
    expect(ORDER_REFUSED_FINAL_COPY).toBe("It wasn't sent. Check the order and submit it again.");
    // The same answers to a RESEND leave the key live: the cause, then the
    // way out.
    for (const r of answers) {
      const o = classifyOrderSubmitResult(r, { sends: 2 });
      expect(o.final).toBe(false);
      if (o.final) continue;
      expect(orderUnconfirmedCopy(o, ctx)).toBe(
        `${ORDER_RESEND_REFUSED_COPY} ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`,
      );
    }
  });

  it('a time zone that could not be read: final on the only send, with a next step', () => {
    const o = classifyOrderSubmitResult(
      refused(409, 'conflict', { reason: 'timezone_unreadable', retryable: true }),
      { sends: 1 },
    );
    expect(o).toMatchObject({ final: true, outcome: 'refused', reason: 'timezone_unreadable' });
    expect(orderRefusalCopy('timezone_unreadable', null, ctx)).toBe(
      "Your organization's time zone couldn't be read, so it wasn't sent. Wait a moment, then submit it again.",
    );
    // On a resend it is only the cause; the suffix says what to do.
    const nf = {
      final: false as const,
      why: 'refused' as const,
      reason: 'timezone_unreadable',
      details: null,
    };
    expect(orderUnconfirmedCopy(nf, ctx)).toBe(
      `${ORDER_TIMEZONE_UNREADABLE_COPY} ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`,
    );
  });

  it('a site on a pickup and a malformed site id get their own words', () => {
    expect(orderRefusalCopy('invalid', d({ field: 'pickupSite' }), ctx)).toBe(
      "A pickup order doesn't take a delivery site.",
    );
    expect(orderRefusalCopy('invalid', d({ field: 'deliveryCharterId' }), ctx)).toBe(
      ORDER_BODY_UNREADABLE_COPY,
    );
    expect(orderRefusalCopy('invalid', d({ field: 'body' }), ctx)).toBe(ORDER_BODY_UNREADABLE_COPY);
  });

  it('the already-placed line names the SO number', () => {
    expect(orderAlreadyPlacedCopy({ orderNumber: 123, orderLabel: 'SO-000123' })).toBe(
      'It had already been placed: SO-000123.',
    );
    expect(orderAlreadyPlacedCopy({ orderNumber: 123, orderLabel: null })).toBe(
      'It had already been placed: SO-000123.',
    );
    expect(orderAlreadyPlacedCopy({ orderNumber: null, orderLabel: null })).toBe(
      'It had already been placed.',
    );
  });

  it('no sentence holds an id, a snake_case token, "try again" for an unknown outcome, or the word for a published title', () => {
    const sentences = Object.entries(placeOrder as Record<string, unknown>)
      .filter(([k, v]) => k.endsWith('_COPY') && typeof v === 'string')
      .map(([k, v]) => [k, v as string] as const);
    expect(sentences.length).toBeGreaterThan(40);
    for (const [name, text] of sentences) {
      expect(text, name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(text, name).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(text, name).not.toMatch(/\bbooks?\b/i);
    }
    // An unknown outcome is never "try again": it is Check and finish.
    for (const text of [
      ORDER_UNCONFIRMED_BODY_COPY,
      ORDER_BUSY_COPY,
      ORDER_RATE_LIMITED_COPY,
      ORDER_CONFLICT_COPY,
      ORDER_FAULT_COPY,
      ORDER_PHONE_AAL2_UNCONFIRMED_COPY,
      ORDER_SIGN_IN_COPY,
      ORDER_REFUSED_RESEND_SUFFIX_COPY,
      ORDER_RESEND_REFUSED_COPY,
      ORDER_UNCONFIRMED_STALE_BODY_COPY,
    ]) {
      expect(text).not.toMatch(/try again/i);
    }
    // A final refusal never points at Check and finish, a button its state
    // does not show; the fault sentence (an unknown outcome) always does.
    for (const text of [ORDER_REFUSED_FINAL_COPY, ORDER_PICKUP_HAS_SITE_COPY]) {
      expect(text).not.toMatch(/Check and finish/);
    }
    expect(ORDER_FAULT_COPY).toMatch(/Check and finish/);
  });
});
