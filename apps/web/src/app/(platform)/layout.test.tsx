import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console's own minimal shell (matrix W-AD-11, P5.3). Pinned: the layout
 * gates with requirePlatformAdmin (a 404 on any failure, so the console is
 * never revealed), it draws only its own top bar (no org shell parts), and the
 * top bar WRAPS. At a 390 px viewport the old single row ('flex items-center
 * gap-4', ~578 px) scrolled the whole console sideways (hand-off from P2.1c);
 * the row now wraps and the nav scrolls inside itself. jsdom cannot measure,
 * so the layout contract is pinned here and the width is measured in the lab
 * (scrollWidth 390 at 390, P5.3 note).
 */

const h = vi.hoisted(() => ({ gate: vi.fn() }));

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: (...a: unknown[]) => h.gate(...a),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/platform' }));

import PlatformLayout from './layout';

beforeEach(() => {
  h.gate.mockReset();
  h.gate.mockResolvedValue({ userId: 'god', email: 'god@stockpilotusa.com' });
});

async function renderLayout() {
  const tree = await PlatformLayout({ children: <p>page body</p> });
  return render(tree);
}

describe('platform console shell', () => {
  it('gates the whole tree, and a failed gate renders nothing', async () => {
    h.gate.mockRejectedValueOnce(new Error('NEXT_HTTP_ERROR_FALLBACK;404'));
    await expect(PlatformLayout({ children: <p>secret</p> })).rejects.toThrow(/404/);
    expect(h.gate).toHaveBeenCalledTimes(1);
  });

  it('keeps the mark, the console nav, the marker, the email and the way back', async () => {
    await renderLayout();
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('link', { name: 'StockPilot / Platform' })).toHaveAttribute(
      'href',
      '/platform',
    );
    const nav = within(banner).getByRole('navigation', { name: 'Platform' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Organizations', 'Provision', 'Support', 'Audit']);
    expect(within(banner).getByText('Platform admin')).toBeInTheDocument();
    expect(within(banner).getByText('god@stockpilotusa.com')).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: '← My workspace' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('main')).toHaveTextContent('page body');
  });

  it('wraps its row instead of overflowing, on a solid surface', async () => {
    const { container } = await renderLayout();
    const header = screen.getByRole('banner');
    expect(header.className).toMatch(/\bsticky\b/);
    const row = header.querySelector('[data-slot="platform-topbar-row"]')!;
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
    // The nav row scrolls inside itself on a phone, never the page.
    const nav = screen.getByRole('navigation', { name: 'Platform' });
    expect(nav.className).toMatch(/\boverflow-x-auto\b/);
    // No blur anywhere in the shell (PLAN 0.6), and no org-shell parts.
    expect(container.innerHTML).not.toMatch(/backdrop-blur/);
    expect(container.querySelector('[data-slot="impersonation-banner"]')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});
