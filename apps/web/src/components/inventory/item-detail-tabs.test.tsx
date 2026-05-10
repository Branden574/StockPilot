import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory/abc',
  useSearchParams: () => new URLSearchParams(''),
}));

import { ItemDetailTabs, parseDetailTab } from './item-detail-tabs';

describe('parseDetailTab', () => {
  it('falls back to overview for unknown/missing values', () => {
    expect(parseDetailTab(undefined)).toBe('overview');
    expect(parseDetailTab(null)).toBe('overview');
    expect(parseDetailTab('')).toBe('overview');
    expect(parseDetailTab('garbage')).toBe('overview');
  });

  it('passes through known tab ids', () => {
    expect(parseDetailTab('overview')).toBe('overview');
    expect(parseDetailTab('movements')).toBe('movements');
    expect(parseDetailTab('activity')).toBe('activity');
  });
});

describe('ItemDetailTabs', () => {
  it('renders all three tabs and marks the active one as aria-selected', () => {
    render(<ItemDetailTabs activeTab="movements" />);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    const movements = screen.getByRole('tab', { name: 'Movements' });
    const activity = screen.getByRole('tab', { name: 'Activity' });

    expect(overview).toHaveAttribute('aria-selected', 'false');
    expect(movements).toHaveAttribute('aria-selected', 'true');
    expect(activity).toHaveAttribute('aria-selected', 'false');
  });

  it('builds the Activity tab href with ?tab=activity', () => {
    render(<ItemDetailTabs activeTab="overview" />);
    const activity = screen.getByRole('tab', { name: 'Activity' });
    expect(activity).toHaveAttribute('href', '/dashboard/inventory/abc?tab=activity');
  });

  it('drops the tab param entirely for the Overview tab href', () => {
    render(<ItemDetailTabs activeTab="movements" />);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('href', '/dashboard/inventory/abc');
  });
});
