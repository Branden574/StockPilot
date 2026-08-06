import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix wave I6: the client crash beacon (`/api/client-error`) must never
 * carry a share token in its `path` field. `/m/<token>` (maintenance share
 * links) and `/r/<token>` (public order-request links) both put the
 * credential in the URL itself — GC 27, never log a share token or signed
 * URL. The beacon requires an authenticated caller server-side
 * (`withApiContext`), but a signed-in staff member can still be on one of
 * these pages (previewing their own org's share link) when a crash fires,
 * so the redaction has to happen client-side, before the token ever leaves
 * the browser.
 */

import GlobalError from './error';

const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));

function setPathname(path: string) {
  window.history.pushState({}, '', path);
}

function bodyOf(call: unknown[]): { path: string | null } {
  return JSON.parse((call[1] as RequestInit).body as string) as { path: string | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

describe('GlobalError crash beacon', () => {
  it('includes the real pathname on an ordinary route', async () => {
    setPathname('/dashboard/items');
    render(<GlobalError error={Object.assign(new Error('boom'), { digest: 'abc' })} reset={() => {}} />);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith('/api/client-error', expect.objectContaining({ method: 'POST' }));
    expect(bodyOf(fetchMock.mock.calls[0]!).path).toBe('/dashboard/items');
  });

  it('MUTATION GUARD — redacts the pathname to null on a maintenance share path (/m/<token>)', async () => {
    setPathname('/m/abcdef0123456789');
    render(<GlobalError error={Object.assign(new Error('boom'), { digest: 'abc' })} reset={() => {}} />);
    await Promise.resolve();

    expect(bodyOf(fetchMock.mock.calls[0]!).path).toBeNull();
  });

  it('MUTATION GUARD — redacts the pathname to null on a public order-request share path (/r/<token>)', async () => {
    setPathname('/r/abcdef0123456789');
    render(<GlobalError error={Object.assign(new Error('boom'), { digest: 'abc' })} reset={() => {}} />);
    await Promise.resolve();

    expect(bodyOf(fetchMock.mock.calls[0]!).path).toBeNull();
  });
});
