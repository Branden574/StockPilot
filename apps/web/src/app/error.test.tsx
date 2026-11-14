import { fireEvent, render, screen } from '@testing-library/react';
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

/**
 * The card's one action. The boundary hands it two functions (Next's error
 * file convention): `retry` asks the server for the page again and renders
 * what comes back; `reset` only clears the error and renders the same failed
 * answer again. A page that could not be read (a public link, the customer
 * portal) needs the first, so Try again uses it, and falls back to `reset`
 * only when no `retry` is given.
 */
describe('GlobalError: Try again', () => {
  const error = Object.assign(new Error('boom'), { digest: 'abc' });

  it('keeps its words', () => {
    render(<GlobalError error={error} reset={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'We hit an unexpected error. Try again, or refresh the page. If it keeps happening, contact support.',
      ),
    ).toBeInTheDocument();
  });

  it('asks the server for the page again (retry), not only a re-render (reset)', () => {
    const retry = vi.fn();
    const reset = vi.fn();
    render(<GlobalError error={error} retry={retry} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('falls back to reset when the boundary gives no retry', () => {
    const reset = vi.fn();
    render(<GlobalError error={error} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

