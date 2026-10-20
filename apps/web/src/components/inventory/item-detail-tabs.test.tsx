import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory/abc',
  useSearchParams: () => new URLSearchParams(''),
}));

import { ItemDetailTabs } from './item-detail-tabs';
import { parseDetailTab } from './item-detail-tabs-shared';

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

describe('ItemDetailTabs keeps the sticky header height for the #physical-count anchor', () => {
  it('writes the header height to --item-detail-header-h on the page, follows resizes, and clears it on unmount', () => {
    let resize: (() => void) | null = null;
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    let height = 271.4;
    try {
      const { container, unmount } = render(
        <div data-testid="page">
          <div data-item-detail-header="">
            <ItemDetailTabs activeTab="overview" />
          </div>
        </div>,
      );
      const page = screen.getByTestId('page');
      const header = container.querySelector('[data-item-detail-header]') as HTMLElement;
      header.getBoundingClientRect = () => ({ height }) as DOMRect;
      resize!();
      expect(page.style.getPropertyValue('--item-detail-header-h')).toBe('272px');
      height = 407;
      resize!();
      expect(page.style.getPropertyValue('--item-detail-header-h')).toBe('407px');
      unmount();
      expect(page.style.getPropertyValue('--item-detail-header-h')).toBe('');
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  // P68-KBD-01: in the two-column grid, Tab from the right column's last link
  // went back up to Market price's Refresh, which the browser left under the
  // header. The scroller's scroll padding (globals.css) reads this height, so
  // the dashboard's main#main-content must carry it too, and lose it on leaving
  // so no other page is padded.
  it('keeps the same height on the main#main-content scroller, follows resizes, and clears it on unmount', () => {
    let resize: (() => void) | null = null;
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    let height = 213.6;
    try {
      const { container, unmount } = render(
        <main id="main-content" data-testid="scroller">
          <div data-testid="page">
            <div data-item-detail-header="">
              <ItemDetailTabs activeTab="overview" />
            </div>
            <div role="tabpanel" />
          </div>
        </main>,
      );
      const scroller = screen.getByTestId('scroller');
      const page = screen.getByTestId('page');
      const header = container.querySelector('[data-item-detail-header]') as HTMLElement;
      header.getBoundingClientRect = () => ({ height }) as DOMRect;
      resize!();
      expect(scroller.style.getPropertyValue('--item-detail-header-h')).toBe('214px');
      expect(page.style.getPropertyValue('--item-detail-header-h')).toBe('214px');
      height = 318;
      resize!();
      expect(scroller.style.getPropertyValue('--item-detail-header-h')).toBe('318px');
      expect(page.style.getPropertyValue('--item-detail-header-h')).toBe('318px');
      unmount();
      expect(scroller.style.getPropertyValue('--item-detail-header-h')).toBe('');
      expect(page.style.getPropertyValue('--item-detail-header-h')).toBe('');
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
