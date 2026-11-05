import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
vi.mock('@/lib/analytics', () => ({ capture: (...args: unknown[]) => capture(...args) }));

import { INVITE_ONLY_NOTE, SITE_NAV } from './site-links';
import { SiteMenu } from './site-menu';

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
});
