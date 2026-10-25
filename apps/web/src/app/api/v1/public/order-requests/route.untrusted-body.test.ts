import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The public order form is validated before the rate limiter, for anyone, so
 * no body may make that validation expensive or make it throw: a throw escapes
 * the handler and the route answers 500.
 *
 * `quantity` was z.coerce.number(), and zod 3 runs Number(input) before any
 * type check. Number() on an array joins every nested element into one string,
 * which is slow for a deep nest of short arrays (the over-long-array check lets
 * those through) and overflows the stack past a few thousand levels. Number()
 * on an object whose valueOf and toString are not functions throws a TypeError.
 * The schema now hands the coercion only a number or a short string. These
 * tests watch the coercing ZodNumber and Array.prototype.toString (what
 * Number() calls on an array) to prove it, and send bodies nested 500,000
 * levels deep (about 1 MB) into each kind of field.
 */

const checkRateLimitMock = vi.fn(async (_key: string, _limit: number, windowMs: number) => ({
  allowed: true,
  count: 1,
  resetAt: Date.now() + windowMs,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string, limit: number, windowMs: number) =>
    checkRateLimitMock(key, limit, windowMs),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: vi.fn(async () => undefined),
}));
const adminHolder = { client: null as unknown };
const createAdminClientMock = vi.fn(() => adminHolder.client);
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClientMock() }));

import { POST } from './route';

const TOKEN = 'pub_token_abcdef0123456789';
const WAREHOUSE_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';
/** About 1 MB of brackets: the depth a 1 MB body can reach. */
const DEPTH = 500_000;

/** A body whose one line has `quantityJson` (raw JSON text) as its quantity. */
function bodyWithQuantity(quantityJson: string): string {
  return (
    `{"token":"${TOKEN}","warehouseId":"${WAREHOUSE_ID}","requesterName":"Jane Teacher",` +
    `"requesterEmail":"jane@school.edu","lines":[{"itemId":"${ITEM_ID}","quantity":${quantityJson}}]}`
  );
}

/** Raw JSON text, sent as is: JSON.stringify itself overflows on these depths. */
function post(json: string) {
  return new Request('https://test.local/api/v1/public/order-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json,
  }) as unknown as Parameters<typeof POST>[0];
}

/** `[0,0,...(99 zeros),[...]]`: every array is under the 100 limit, so the pre-check passes it. */
function nestOfShortArrays(depth: number): string {
  let s = '0';
  for (let i = 0; i < depth; i++) s = `[${'0,'.repeat(99)}${s}]`;
  return s;
}

function plainNest(depth: number): string {
  return `${'['.repeat(depth)}1${']'.repeat(depth)}`;
}

/** The full happy path (legacy organization token), as route.test.ts wires it. */
function wireHappyAdmin() {
  const stub = makeSupabaseStub({
    'organizations.select.maybeSingle': { data: { id: 'org-1' }, error: null },
    'organization_modules.select.maybeSingle': {
      data: { module_id: 'public_requests' },
      error: null,
    },
    'warehouses.select.maybeSingle': {
      data: { id: WAREHOUSE_ID, is_public_orderable: true, organization_id: 'org-1' },
      error: null,
    },
    'inventory_items.select': {
      data: [
        {
          id: ITEM_ID,
          warehouse_id: WAREHOUSE_ID,
          unit_cost: 8.5,
          item_type: 'book',
          status: 'active',
          deleted_at: null,
        },
      ],
      error: null,
    },
    'order_requests.insert.single': {
      data: { id: 'req-1', organization_id: 'org-1', warehouse_id: WAREHOUSE_ID },
      error: null,
    },
    'order_request_lines.insert': { data: null, error: null },
    'rpc:cleanup_expired_unconfirmed_order_requests': { data: null, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

/** What each coercing ZodNumber was handed, recorded before it calls Number(). */
let coerced: string[];
let numberParse: ReturnType<typeof vi.spyOn>;
let arrayToString: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = null;
  coerced = [];
  const original = z.ZodNumber.prototype._parse;
  numberParse = vi.spyOn(z.ZodNumber.prototype, '_parse').mockImplementation(function (
    this: z.ZodNumber,
    input: z.ParseInput,
  ) {
    if (this._def.coerce) {
      const data: unknown = input.data;
      coerced.push(Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data);
    }
    return original.call(this, input);
  });
  arrayToString = vi.spyOn(Array.prototype, 'toString');
});

afterEach(() => {
  numberParse.mockRestore();
  arrayToString.mockRestore();
});

/** Calls of Array.prototype.toString on an array that holds another array: only a body's nest can be one. */
function nestedArraysStringified(): number {
  return arrayToString.mock.contexts.filter(
    (self: unknown) => Array.isArray(self) && self.some(Array.isArray),
  ).length;
}

describe('POST /api/v1/public/order-requests: a quantity that is not a number or a short string', () => {
  it('a deep nest of short arrays is refused with a 400 and never reaches Number()', async () => {
    const res = await POST(post(bodyWithQuantity(nestOfShortArrays(2_000))));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid input' });
    expect(coerced).toEqual([]);
    expect(nestedArraysStringified()).toBe(0);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('an array as deep as a 1 MB body allows is a 400, not a stack overflow', async () => {
    const res = await POST(post(bodyWithQuantity(plainNest(DEPTH))));

    expect(res.status).toBe(400);
    expect(coerced).toEqual([]);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('a one-element array, which Number() would have read as its element, is refused', async () => {
    const res = await POST(post(bodyWithQuantity('[3]')));

    expect(res.status).toBe(400);
    expect(coerced).toEqual([]);
  });

  it('an object with no usable valueOf or toString is a 400, not a TypeError', async () => {
    for (const quantity of ['{"valueOf":1,"toString":1}', '[{"valueOf":1,"toString":1}]', '{}']) {
      const res = await POST(post(bodyWithQuantity(quantity)));
      expect(res.status, quantity).toBe(400);
    }
    expect(coerced).toEqual([]);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('a quantity string longer than 12 characters is refused before Number() reads it', async () => {
    const res = await POST(post(bodyWithQuantity(`"${'1'.repeat(13)}"`)));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'String must contain at most 12 character(s)' });
    expect(coerced).toEqual([]);
  });
});

describe('POST /api/v1/public/order-requests: nesting anywhere in the body never answers 500', () => {
  it.each([
    ['a line note', (nest: string) => bodyWithQuantity(`1,"notes":${nest}`)],
    ['the honeypot', (nest: string) => `${bodyWithQuantity('1').slice(0, -1)},"hp":${nest}}`],
    ['the whole body', (nest: string) => nest],
    [
      'a line',
      (nest: string) => bodyWithQuantity('1').replace(/"lines":\[.*\]/, `"lines":[${nest}]`),
    ],
  ])('%s nested 500,000 levels deep is a 400', async (_where, build) => {
    const res = await POST(post(build(plainNest(DEPTH))));

    expect(res.status).toBe(400);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('a body nested under a key the schema strips goes through as the request it carries', async () => {
    wireHappyAdmin();
    const res = await POST(
      post(`${bodyWithQuantity('1').slice(0, -1)},"extra":${plainNest(DEPTH)}}`),
    );

    expect(res.status).toBe(200);
    expect(checkRateLimitMock).toHaveBeenCalled();
  });

  it('if checking the body throws anyway, the answer is the 400, before the rate limiter', async () => {
    // Nothing in the schema throws today (the cases above); this pins what a
    // future change that does would get: a refusal, never a 500. safeParse is
    // bound to each schema when it is built, so the throw goes in the object
    // parser it calls.
    const objectParse = vi.spyOn(z.ZodObject.prototype, '_parse').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      const res = await POST(post(bodyWithQuantity('1')));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'validation_error' });
      expect(objectParse).toHaveBeenCalled();
      expect(checkRateLimitMock).not.toHaveBeenCalled();
      expect(createAdminClientMock).not.toHaveBeenCalled();
    } finally {
      objectParse.mockRestore();
    }
  });
});

describe('POST /api/v1/public/order-requests: a normal cart still validates', () => {
  it.each([
    ['a number', '3'],
    ['a numeric string', '"3"'],
  ])('a quantity sent as %s is coerced and submitted as 3', async (_kind, quantity) => {
    const stub = wireHappyAdmin();
    const res = await POST(post(bodyWithQuantity(quantity)));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('req-1');
    // The coercion still runs, on the number or the string the cart sent.
    expect(coerced).toEqual([quantity.startsWith('"') ? 'string' : 'number']);
    // The line is written with the number 3, not the string.
    const inserted = stub.chainArgsAll.get('order_request_lines.insert');
    expect(JSON.stringify(inserted)).toContain('"quantity_requested":3,');
  });

  it('a fractional, zero or too-large quantity is still refused with the words it got before', async () => {
    const cases: Array<[string, string]> = [
      ['2.5', 'Expected integer, received float'],
      ['"2.5"', 'Expected integer, received float'],
      ['0', 'Number must be greater than 0'],
      ['10001', 'Number must be less than or equal to 10000'],
      ['"abc"', 'Expected number, received nan'],
    ];
    for (const [quantity, words] of cases) {
      const res = await POST(post(bodyWithQuantity(quantity)));
      expect(res.status, quantity).toBe(400);
      expect(await res.json(), quantity).toEqual({ error: words });
    }
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});
