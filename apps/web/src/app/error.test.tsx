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

import { ACCESS_UNCHECKED_DIGEST, LINK_UNCHECKED_DIGEST } from '@/lib/known-error-states';

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

/**
 * A digest the app set itself names a state it knows (lib/known-error-states):
 * the customer portal when the access check could not be made, a public link
 * when the link could not be checked. The card then says that, in plain
 * words, with Try again, instead of "Something went wrong". No raw error
 * message is ever on this card.
 */
describe('GlobalError: a state the app knows by its digest', () => {
  const STAND_IN =
    'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.';

  it.each([
    [
      'the access check could not be made',
      ACCESS_UNCHECKED_DIGEST,
      "We couldn't check your access just now. This is usually temporary.",
    ],
    [
      'the link could not be checked',
      LINK_UNCHECKED_DIGEST,
      "We couldn't check this link just now. This is usually temporary.",
    ],
  ])('%s: the plain state with Try again', (_name, digest, sentence) => {
    const retry = vi.fn();
    const { container } = render(
      <GlobalError error={Object.assign(new Error(STAND_IN), { digest })} retry={retry} reset={() => {}} />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: "This page couldn't be loaded" }),
    ).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.textContent).not.toContain('unexpected error');
    expect(container.textContent).not.toContain('Minified React error');
    expect(container.textContent).not.toContain('react.dev');
    expect(container.textContent).not.toContain(digest);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('any other error is the card as before, and it never prints the error message', () => {
    const { container } = render(
      <GlobalError error={Object.assign(new Error(STAND_IN), { digest: '2416532942' })} reset={() => {}} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('Minified React error');
    expect(container.textContent).not.toContain('react.dev');
  });
});

