import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
vi.mock('@/lib/analytics', () => ({ capture: (...args: unknown[]) => capture(...args) }));

vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));

import { INVITE_ONLY_NOTE, SITE_NAV, type SitePage } from './site-links';
import { SiteMenuButton, SiteMenuPanel, SiteMenuRoot } from './site-menu';
import { SiteNav } from './site-nav';

/** The three parts as SiteNav puts them: the button in the nav, the panel after it. */
function SiteMenu({ links, active }: { links: typeof SITE_NAV; active: SitePage }) {
  return (
    <SiteMenuRoot className="lgs-navbar">
      <nav className="lgs-nav">
        <SiteMenuButton />
      </nav>
      <SiteMenuPanel links={links} active={active} />
    </SiteMenuRoot>
  );
}

/**
 * The phone menu of the glass marketing nav (SiteNav.dc.html below 900 px).
 * Its states: closed (Open menu, collapsed), open (Close menu, expanded, the
 * five links, Contact the team, Sign in and the invite-only line), and closed
 * again by the button, Escape (focus back on the button) or a link.
 */

afterEach(() => {
  capture.mockReset();
});

const button = () => screen.getByRole('button', { name: /menu$/u });

describe('SiteMenu', () => {
  it('starts closed: "Open menu", collapsed, no menu in the document', () => {
    render(<SiteMenu links={SITE_NAV} active="home" />);
    expect(button()).toHaveAccessibleName('Open menu');
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('lgs-site-menu')).toBeNull();
  });

  it('opens: "Close menu", expanded, controlling the menu with every link, Contact, Sign in and the invite-only line', () => {
    render(<SiteMenu links={SITE_NAV} active="security" />);
    fireEvent.click(button());
    expect(button()).toHaveAccessibleName('Close menu');
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById(button().getAttribute('aria-controls')!)!;
    expect(menu).not.toBeNull();
    const links = within(menu).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ...SITE_NAV.map((l) => [l.label, l.href]),
      ['Contact the team', '/contact'],
      ['Sign in', '/signin'],
    ]);
    expect(within(menu).getByRole('link', { name: 'Security' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getByRole('link', { name: 'Support' })).not.toHaveAttribute('aria-current');
    expect(menu).toHaveTextContent(INVITE_ONLY_NOTE);
  });

  it('Escape closes it and puts focus back on the button', () => {
    render(<SiteMenu links={SITE_NAV} active="home" />);
    fireEvent.click(button());
    within(document.getElementById('lgs-site-menu')!).getAllByRole('link')[0]!.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.getElementById('lgs-site-menu')).toBeNull();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(button()).toHaveFocus();
  });

  it('a link closes it, and the button toggles it shut', () => {
    render(<SiteMenu links={SITE_NAV} active="home" />);
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('link', { name: 'Contact the team' }));
    expect(document.getElementById('lgs-site-menu')).toBeNull();
    fireEvent.click(button());
    fireEvent.click(button());
    expect(document.getElementById('lgs-site-menu')).toBeNull();
  });

  it('Sign in on the landing sends the classic landing menu event; on other pages it sends nothing', () => {
    const { unmount } = render(<SiteMenu links={SITE_NAV} active="home" />);
    fireEvent.click(button());
    const signIn = screen.getByRole('link', { name: 'Sign in' });
    signIn.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(signIn);
    expect(capture).toHaveBeenCalledWith('landing_app_entry_clicked', { where: 'menu-signin' });
    unmount();
    capture.mockReset();
    render(<SiteMenu links={SITE_NAV} active="pricing" />);
    fireEvent.click(button());
    const other = screen.getByRole('link', { name: 'Sign in' });
    other.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(other);
    expect(capture).not.toHaveBeenCalled();
  });

  it('SiteNav puts the open panel where the board draws it: the nav’s next sibling inside the navbar, in flow (never inside the blurred nav, never absolutely placed)', () => {
    const { container } = render(<SiteNav active="home" />);
    fireEvent.click(button());
    const menu = document.getElementById('lgs-site-menu')!;
    const nav = container.querySelector('nav.lgs-nav')!;
    const navbar = container.querySelector('.lgs-navbar')!;
    expect(nav.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(navbar);
    expect(menu.previousElementSibling).toBe(nav);
    expect(nav.contains(button())).toBe(true);
    for (const cls of ['absolute', 'fixed', 'inset-x-3', 'top-full', 'mt-2']) {
      expect(menu.classList.contains(cls), cls).toBe(false);
    }
  });

  it('SiteNav without the menu open renders no panel (the server HTML is the closed menu)', () => {
    const { container } = render(<SiteNav active="pricing" />);
    expect(container.querySelector('#lgs-site-menu')).toBeNull();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });
});
