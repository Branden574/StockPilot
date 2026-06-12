import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { IntacctApiError, IntacctClient } from './client';

const SECRETS = { accessToken: 'bearer-secret-xyz', refreshToken: 'rt', expiresAt: '' };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('IntacctClient.queryPage', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parses the documented envelope and advances the cursor', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        'ia::result': [{ id: 'A' }, { id: 'B' }],
        'ia::meta': { totalCount: 5, start: 1, numRemaining: 3 },
      }),
    );
    const page = await new IntacctClient(SECRETS).queryPage({
      object: 'inventory-control/item',
      fields: ['id'],
      start: 1,
      size: 2,
    });
    expect(page.records).toHaveLength(2);
    expect(page.nextStart).toBe(3);
  });

  it('terminates when numRemaining is 0', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ 'ia::result': [{ id: 'A' }], 'ia::meta': { numRemaining: 0 } }),
    );
    const page = await new IntacctClient(SECRETS).queryPage({
      object: 'inventory-control/item',
      fields: ['id'],
    });
    expect(page.nextStart).toBeNull();
  });

  it('GUARD: an empty records page terminates even when meta claims more remain', async () => {
    // Envelope-shape drift (meta parses, records do not) would otherwise pin
    // nextStart === start and spin callers forever against the Intacct quota.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ unexpected: { shape: true }, 'ia::meta': { start: 1, numRemaining: 100 } }),
    );
    const page = await new IntacctClient(SECRETS).queryPage({
      object: 'inventory-control/item',
      fields: ['id'],
      start: 1,
    });
    expect(page.records).toHaveLength(0);
    expect(page.nextStart).toBeNull();
  });

  it('throws a token-free IntacctApiError on a non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const err = await new IntacctClient(SECRETS)
      .queryPage({ object: 'x', fields: ['id'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntacctApiError);
    expect((err as IntacctApiError).status).toBe(403);
    expect((err as IntacctApiError).message).not.toContain('bearer-secret-xyz');
  });
});
