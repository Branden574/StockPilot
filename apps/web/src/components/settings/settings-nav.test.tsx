import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '@stockpilot/core';

/**
 * The settings gate table, the grouped index and the sub-nav share one table
 * (W-ST-01 / 01a). These pin the table's entries, its gates and the phone
 * menu's behaviour.
 */

const pathHolder = vi.hoisted(() => ({ current: '/dashboard/settings/security' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathHolder.current,
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import {
  SETTINGS_ENTRY_UNCHECKED_NOTE,
  SETTINGS_NAV_GROUPS,
  SettingsFrame,
  SettingsPanel,
  SettingsSubNav,
  activeSettingsEntry,
  visibleSettingsGroups,
} from './settings-nav';

const everything = { permissions: [...PERMISSIONS], modules: ['maintenance_requests' as const] };

beforeEach(() => {
  pathHolder.current = '/dashboard/settings/security';
});

describe('settings gate table', () => {
  it('holds the 21 hub destinations, each once, under seven groups', () => {
    const entries = SETTINGS_NAV_GROUPS.flatMap((g) => g.entries);
    expect(entries).toHaveLength(21);
    expect(new Set(entries.map((e) => e.href)).size).toBe(21);
    expect(SETTINGS_NAV_GROUPS.map((g) => g.label)).toEqual([
      'Account',
      'Workspace',
      'Access',
      'Requests and email',
      'Data safety',
      'Connections',
      'Plan',
    ]);
  });

  it('keeps the five base destinations ungated and Maintenance requests behind both its gates', () => {
    const base = visibleSettingsGroups({ permissions: [], modules: [] }).flatMap((g) =>
      g.entries.map((e) => e.title),
    );
    expect(base).toEqual([
      'Profile',
      'Security',
      'Notifications',
      'Organization',
      'Roles & permissions',
    ]);

    const configureOnly = visibleSettingsGroups({
      permissions: ['maintenance_requests:configure'],
      modules: [],
    }).flatMap((g) => g.entries.map((e) => e.title));
    expect(configureOnly).not.toContain('Maintenance requests');

    const moduleOnly = visibleSettingsGroups({
      permissions: [],
      modules: ['maintenance_requests'],
    }).flatMap((g) => g.entries.map((e) => e.title));
    expect(moduleOnly).not.toContain('Maintenance requests');

    expect(
      visibleSettingsGroups(everything).flatMap((g) => g.entries.map((e) => e.title)),
    ).toContain('Maintenance requests');
  });

  it('finds the destination a nested path belongs to', () => {
    const groups = visibleSettingsGroups(everything);
    expect(activeSettingsEntry(groups, '/dashboard/settings/public-requests/abc')?.title).toBe(
      'Public requests',
    );
    expect(activeSettingsEntry(groups, '/dashboard/settings/migrate/sage50')?.title).toBe(
      'Integrations',
    );
    expect(activeSettingsEntry(groups, '/dashboard/settings')).toBeNull();
  });

  // Docket R7: a module whose state could not be read is not "off", and never "on".
  describe('a module that could not be checked', () => {
    const entriesOf = (access: Parameters<typeof visibleSettingsGroups>[0]) =>
      visibleSettingsGroups(access).flatMap((g) => g.entries);

    it('keeps the destination, marked unchecked, for a caller its permission shows it to', () => {
      const entries = entriesOf({
        permissions: ['maintenance_requests:configure'],
        modules: [],
        uncheckedModules: ['maintenance_requests'],
      });
      expect(entries.find((e) => e.title === 'Maintenance requests')).toMatchObject({
        href: '/dashboard/settings/maintenance',
        unchecked: true,
      });
      // No other destination is marked.
      expect(entries.filter((e) => e.unchecked).map((e) => e.title)).toEqual([
        'Maintenance requests',
      ]);
    });

    it('never shows it to a caller without that permission', () => {
      const entries = entriesOf({
        permissions: [],
        modules: [],
        uncheckedModules: ['maintenance_requests'],
      });
      expect(entries.map((e) => e.title)).not.toContain('Maintenance requests');
    });

    it('a module that IS on is a plain link, whatever else is listed', () => {
      const entry = entriesOf({ ...everything, uncheckedModules: ['maintenance_requests'] }).find(
        (e) => e.title === 'Maintenance requests',
      );
      expect(entry?.unchecked).toBeUndefined();
    });

    it('is never the current destination, even on its own path', () => {
      const groups = visibleSettingsGroups({
        permissions: [...PERMISSIONS],
        modules: [],
        uncheckedModules: ['maintenance_requests'],
      });
      expect(activeSettingsEntry(groups, '/dashboard/settings/maintenance')).toBeNull();
      expect(activeSettingsEntry(groups, '/dashboard/settings/email-routing')?.title).toBe(
        'Email routing',
      );
    });

    it('the sub-nav draws it without a link, with the note and Try again', () => {
      render(
        <SettingsSubNav
          access={{
            permissions: [...PERMISSIONS],
            modules: [],
            uncheckedModules: ['maintenance_requests'],
          }}
        />,
      );
      const nav = screen.getByRole('navigation', { name: 'Settings' });
      // 21 destinations and All settings, less the one that is not a link.
      expect(within(nav).getAllByRole('link')).toHaveLength(21);
      expect(within(nav).queryByRole('link', { name: 'Maintenance requests' })).toBeNull();
      const row = nav.querySelector('[data-slot="settings-entry-unchecked"]') as HTMLElement;
      expect(row.closest('li')).not.toBeNull();
      expect(within(row).getByText('Maintenance requests')).toBeInTheDocument();
      expect(within(row).getByText(SETTINGS_ENTRY_UNCHECKED_NOTE)).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Try again' })).toHaveClass('h-7');
    });
  });
});

describe('SettingsPanel', () => {
  it('is a region named by its title by default, with headingId on the heading', () => {
    const { container } = render(
      <SettingsPanel title="Snapshots" headingId="snapshots-heading" flush>
        <p>No restore points yet.</p>
      </SettingsPanel>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Snapshots' })).toHaveAttribute(
      'id',
      'snapshots-heading',
    );
    const section = container.querySelector('section');
    expect(section).toHaveAttribute('aria-labelledby', 'snapshots-heading');
    expect(section).toHaveAccessibleName('Snapshots');
    const regions = screen.getAllByRole('region', { name: 'Snapshots' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(section);
  });

  it('is a region named by its title by default when no headingId is passed', () => {
    const { container } = render(<SettingsPanel title="Create a restore point" />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Create a restore point' });
    expect(heading.id).not.toBe('');
    expect(container.querySelector('section')).toHaveAttribute('aria-labelledby', heading.id);
    expect(screen.getByRole('region', { name: 'Create a restore point' })).toBe(
      container.querySelector('section'),
    );
  });

  it('with landmark={false} leaves the title to the table region inside, so the name is listed once', () => {
    const { container } = render(
      <SettingsPanel title="Snapshots" headingId="snapshots-heading" landmark={false} flush>
        <div role="region" aria-labelledby="snapshots-heading" />
      </SettingsPanel>,
    );
    // The title is still the card's heading, and still carries the id.
    expect(screen.getByRole('heading', { level: 2, name: 'Snapshots' })).toHaveAttribute(
      'id',
      'snapshots-heading',
    );
    expect(container.querySelector('section')).not.toHaveAttribute('aria-labelledby');
    const regions = screen.getAllByRole('region', { name: 'Snapshots' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(container.querySelector('div[role="region"]'));
  });
});

describe('SettingsSubNav focus ring', () => {
  // P68-KBD-02: from 1280 px the rail is a 248 px scroller with no right
  // padding, and its links run to that edge, so the ring drawn outside a link
  // lost its right side. Each link now draws it inside its own edge, as the
  // settings index rows do, and the rail keeps its width and padding.
  it('draws every link ring inside the link, and the rail keeps its 248 px and no right padding', () => {
    const { container } = render(
      <SettingsFrame nav={<SettingsSubNav access={everything} />}>
        <p>Page</p>
      </SettingsFrame>,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toContain('All settings');
    expect(links).toHaveLength(22);
    for (const link of links) {
      expect(link).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
    const rail = container.querySelector('[data-slot="settings-frame"] > div') as HTMLElement;
    expect(rail).toContainElement(nav);
    expect(rail).toHaveClass('xl:w-[248px]', 'xl:overflow-y-auto', 'xl:pr-0');
  });
});

describe('SettingsSubNav phone menu', () => {
  it('names the current page on its button and opens and closes the list', () => {
    render(<SettingsSubNav access={everything} />);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const toggle = within(nav).getByRole('button', { name: /Settings\s*Security/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(nav).getByRole('link', { name: 'Profile' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).getByRole('link', { name: 'All settings' })).toHaveAttribute(
      'href',
      '/dashboard/settings',
    );
  });
});
