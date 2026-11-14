import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

import { ModulesUnreadBanner } from './modules-unread-banner';

beforeEach(() => nav.refresh.mockReset());

/**
 * The strip the dashboard layout shows when the organization's module state
 * could not be read: it says so, says the menu may be incomplete, and its one
 * action asks the server for the page again.
 */
describe('ModulesUnreadBanner', () => {
  it('says the modules could not be checked and that menu items may be missing', () => {
    render(<ModulesUnreadBanner />);
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain("We couldn't check which modules are on.");
    expect(strip.textContent).toContain(
      'Some menu items may be missing. This is usually temporary.',
    );
    // It never says a module is off or not enabled.
    expect(strip.textContent).not.toMatch(/not enabled|turned off|switched off/i);
  });

  it('Try again asks the server for the page again', () => {
    render(<ModulesUnreadBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});
