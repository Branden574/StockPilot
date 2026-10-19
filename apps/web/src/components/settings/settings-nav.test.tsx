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
  SETTINGS_NAV_GROUPS,
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
