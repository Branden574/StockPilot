import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SPENT_SESSION_FRAGMENT } from '@/lib/auth/auth-page-notices';

import { SessionFragmentScrub } from './session-fragment-scrub';

/**
 * A link Supabase verified itself hands its session back in the URL fragment,
 * and the app's redirects keep it on the way to /signin. The app never uses
 * that session (lib/supabase/client.test.ts), so the scrub takes the live
 * tokens out of the address bar and the history entry, and leaves a fragment
 * the sign-in form still reads as a failed link. Placeholder tokens only.
 */

const SESSION =
  '#access_token=header.payload.signature&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery';

function at(pathAndQuery: string, fragment = '') {
  window.history.replaceState(null, '', `${pathAndQuery}${fragment}`);
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  at('/');
});

describe('SessionFragmentScrub', () => {
  it('drops the session from the address bar and keeps the page, its query and the failure', () => {
    at('/signin?error=auth_callback_failed', SESSION);
    render(<SessionFragmentScrub />);
    vi.runAllTimers();
    expect(window.location.pathname).toBe('/signin');
    expect(window.location.search).toBe('?error=auth_callback_failed');
    expect(window.location.hash).toBe(SPENT_SESSION_FRAGMENT);
    expect(window.location.href).not.toMatch(/access_token|refresh_token|header\.payload/);
  });

  it('replaces the history entry with a null state, after the router has patched history', () => {
    // Next's App Router patches history.replaceState in its own mount effect,
    // which runs after this child's; called with a null state once that patch
    // is in place, it moves the router's own URL too, so the router never
    // writes the old fragment back. History's own state is never passed: it
    // carries the router's marker, and the patch would then skip the sync.
    // The entry as the router leaves it: its marker and its tree in the state.
    window.history.replaceState(
      { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } },
      '',
      '/signin?redirect=%2Fdashboard#access_token=header.payload.signature&type=invite',
    );
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<SessionFragmentScrub />);
    expect(replace).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(
      null,
      '',
      `/signin?redirect=%2Fdashboard${SPENT_SESSION_FRAGMENT}`,
    );
  });

  it('leaves every other fragment, and no fragment, alone', () => {
    for (const fragment of ['', '#top', '#error=access_denied&error_code=otp_expired']) {
      at('/signin?error=auth_callback_failed', fragment);
      const replace = vi.spyOn(window.history, 'replaceState');
      const { unmount } = render(<SessionFragmentScrub />);
      vi.runAllTimers();
      expect(replace, fragment).not.toHaveBeenCalled();
      unmount();
      replace.mockRestore();
    }
  });

  it('does nothing once it is gone before its turn comes', () => {
    at('/signin', SESSION);
    const replace = vi.spyOn(window.history, 'replaceState');
    const { unmount } = render(<SessionFragmentScrub />);
    unmount();
    vi.runAllTimers();
    expect(replace).not.toHaveBeenCalled();
  });
});
