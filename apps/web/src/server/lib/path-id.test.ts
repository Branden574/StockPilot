import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two path id checks (B63). A page checks its id with notFoundUnlessUuid
 * (a malformed id is Page not found, before anything is read); a route checks
 * it with invalidPathIdResponse, which returns the 400 answer and never
 * throws (a throw inside a route's try/catch would become a 500).
 */
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('notFound');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));

import { invalidPathIdResponse, notFoundUnlessUuid } from './path-id';

const ID = '0a000000-0000-4000-8000-000000000201';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notFoundUnlessUuid (pages)', () => {
  it('lets a uuid through, in any case, without calling notFound', () => {
    expect(() => notFoundUnlessUuid(ID)).not.toThrow();
    expect(() => notFoundUnlessUuid(ID.toUpperCase())).not.toThrow();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('calls notFound for an id that is not a uuid', () => {
    for (const bad of ['not-a-uuid', '', '-'.repeat(36), ID.slice(0, -1), `${ID}x`]) {
      notFound.mockClear();
      expect(() => notFoundUnlessUuid(bad), bad).toThrow('notFound');
      expect(notFound, bad).toHaveBeenCalledTimes(1);
    }
  });
});

describe('invalidPathIdResponse (routes)', () => {
  it('returns null for a uuid', () => {
    expect(invalidPathIdResponse(ID, 'That order id is not valid.')).toBeNull();
    expect(invalidPathIdResponse(ID.toUpperCase(), 'That order id is not valid.')).toBeNull();
  });

  it('answers a malformed id 400 validation_error with the words it is given', async () => {
    const res = invalidPathIdResponse('not-a-uuid', 'That order id is not valid.');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({
      error: 'validation_error',
      message: 'That order id is not valid.',
    });
  });

  it('carries the headers it is given', () => {
    const res = invalidPathIdResponse('abc', 'That order id is not valid.', {
      'cache-control': 'private, no-store',
    });
    expect(res!.status).toBe(400);
    expect(res!.headers.get('cache-control')).toBe('private, no-store');
  });

  it('never throws and never calls notFound', () => {
    for (const bad of ['', '-'.repeat(36), '0'.repeat(36), `${ID}/`]) {
      expect(() => invalidPathIdResponse(bad, 'That order id is not valid.')).not.toThrow();
      expect(invalidPathIdResponse(bad, 'That order id is not valid.')!.status).toBe(400);
    }
    expect(notFound).not.toHaveBeenCalled();
  });
});
