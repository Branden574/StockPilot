import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Security invariant: the three public form posts (order requests, return
 * requests, return options) take a body of at most 256 KB. A larger one is
 * answered 413 with a short message, before the body is parsed, before the
 * rate limiter and before the admin client. A body within the limit goes on
 * to validation as before.
 */

const checkRateLimit = vi.fn(async (..._a: unknown[]) => ({
  allowed: true,
  count: 1,
  resetAt: Date.now() + 3_600_000,
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
const createAdminClient = vi.fn(() => ({ admin: true }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }));
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/returns', () => ({ createRequesterReturn: vi.fn() }));
vi.mock('@/server/services/returns-requester', () => ({ exchangeOptionsForToken: vi.fn() }));
vi.mock('server-only', () => ({}));

import { POST as postOrderRequest } from './order-requests/route';
import { POST as postReturn } from './returns/route';
import { POST as postReturnOptions } from './returns/options/route';

type Handler = (req: never) => Promise<Response>;

const ROUTES: Array<[string, Handler]> = [
  ['order-requests', postOrderRequest as unknown as Handler],
  ['returns', postReturn as unknown as Handler],
  ['returns/options', postReturnOptions as unknown as Handler],
];

const LIMIT = 256 * 1024;
const TOO_LARGE = { error: 'payload_too_large', message: 'This form is too large to send.' };

/** A JSON body of exactly `size` bytes. */
function bodyOfSize(size: number): string {
  const shell = JSON.stringify({ token: 'x', notes: '' });
  return JSON.stringify({ token: 'x', notes: 'n'.repeat(size - shell.length) });
}

function post(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`https://test.local/api/v1/public/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7', ...headers },
    body,
    duplex: 'half',
  } as RequestInit) as never;
}

/** The body as a stream with no declared length (chunked transfer). */
function chunked(text: string) {
  const all = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= all.length) return controller.close();
      controller.enqueue(all.slice(at, at + 16 * 1024));
      at += 16 * 1024;
    },
  });
}

let objectParse: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  objectParse?.mockRestore();
  objectParse = vi.spyOn(z.ZodObject.prototype, '_parse');
});

describe.each(ROUTES)('POST /api/v1/public/%s: body size limit', (path, handler) => {
  it('answers 413 for a declared length over 256 KB, before parsing or any limit or client', async () => {
    const res = await handler(post(path, bodyOfSize(LIMIT + 1)));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(TOO_LARGE);
    expect(objectParse).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('answers 413 for a chunked body over 256 KB with no declared length', async () => {
    const res = await handler(post(path, chunked(bodyOfSize(LIMIT + 1))));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(TOO_LARGE);
    expect(objectParse).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('takes a body of exactly 256 KB on to validation', async () => {
    const res = await handler(post(path, bodyOfSize(LIMIT)));

    expect(res.status).not.toBe(413);
    expect(objectParse).toHaveBeenCalled();
  });

  it('keeps its 400 for a body that is not JSON', async () => {
    const res = await handler(post(path, '{not json'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('answers no-store when the route does', async () => {
    const res = await handler(post(path, bodyOfSize(LIMIT + 1)));
    if (path.startsWith('returns')) expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
