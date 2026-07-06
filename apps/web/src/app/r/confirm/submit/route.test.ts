import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * POST /r/confirm/submit is the ONLY place the public order-request
 * confirmation token may be consumed (the GET page renders a
 * click-through form; see page.test.tsx). This suite pins:
 *   - the happy path calls the 0108 RPC with the sha256 of the token
 *     (plaintext never leaves the process) and lands on ?done=,
 *   - a re-POST of a consumed token (RPC → null) lands on the
 *     already-used panel via ?e=1, never a 5xx,
 *   - malformed input short-circuits before any admin client work,
 *   - the route exports no GET — a scanner following the form URL gets
 *     a 405, not a consumption path.
 */

const adminHolder = { client: null as unknown };
const createAdminClientMock = vi.fn(() => adminHolder.client);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import * as route from './route';

const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'ab'.repeat(32);

function buildPost(fields: Record<string, string>) {
  return new Request('https://test.local/r/confirm/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  }) as unknown as Parameters<typeof route.POST>[0];
}

function wireRpc(result: string | null): SupabaseStub {
  const stub = makeSupabaseStub({
    'rpc:confirm_public_order_request': { data: result, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

describe('POST /r/confirm/submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminHolder.client = null;
  });

  it('consumes the token via the RPC (hashed, never plaintext) and redirects to the success state', async () => {
    const stub = wireRpc('org-1');

    const res = await route.POST(buildPost({ id: ID, t: TOKEN }));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://test.local/r/confirm?done=${ID}`);
    expect(stub.rpcCalls).toEqual([
      {
        name: 'confirm_public_order_request',
        args: {
          p_id: ID,
          p_token_hash: createHash('sha256').update(TOKEN).digest('hex'),
        },
      },
    ]);
  });

  it('redirects a consumed/expired token to the already-used panel, not an error', async () => {
    wireRpc(null); // second POST: RPC finds no pending row

    const res = await route.POST(buildPost({ id: ID, t: TOKEN }));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://test.local/r/confirm?e=1');
  });

  it('rejects malformed params before touching the admin client', async () => {
    const res = await route.POST(buildPost({ id: 'nope', t: 'short' }));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://test.local/r/confirm?e=1');
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('exports no GET handler — the token cannot be consumed by a link fetch', () => {
    expect('GET' in route).toBe(false);
  });
});
