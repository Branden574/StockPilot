import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

import { ModulesUnreadBanner } from './modules-unread-banner';

beforeEach(() => nav.refresh.mockReset());
afterEach(() => vi.restoreAllMocks());

/**
 * The strip the dashboard layout shows when the organization's module state
 * could not be read: it says so, says that pages and menu items may be
 * unavailable, and its one action loads the whole page again.
 *
 * A full page load, not a refresh of the server components: the page under
 * the strip may be showing its own error state, and an error boundary keeps
 * its error through a refresh. One press has to bring back both the menu and
 * the page.
 */
describe('ModulesUnreadBanner', () => {
  it('says the modules could not be checked and that pages and menu items may be unavailable', () => {
    render(<ModulesUnreadBanner />);
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain("We couldn't check which modules are on.");
    expect(strip.textContent).toContain(
      'Some pages and menu items may be unavailable. This is usually temporary.',
    );
    // It never says a module is off or not enabled.
    expect(strip.textContent).not.toMatch(/not enabled|turned off|switched off/i);
  });

  it('Try again loads the whole page again, so the page under the strip recovers with the menu', () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    render(<ModulesUnreadBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // Not a refresh of the server components alone.
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
