import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cycleCountListHref, cycleCountListHrefFromQuery } from './cycle-count-list-href';
import { BackToCycleCounts, RememberCycleCountListView } from './cycle-count-list-memory';

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('cycleCountListHref', () => {
  it('spells each view one way', () => {
    expect(cycleCountListHref({})).toBe('/dashboard/cycle-counts');
    expect(cycleCountListHref({ q: ' CC-42 ', page: 1 })).toBe('/dashboard/cycle-counts?q=CC-42');
    expect(cycleCountListHref({ q: 'a&b', status: 'completed', page: 3 })).toBe(
      '/dashboard/cycle-counts?q=a%26b&status=completed&page=3',
    );
    expect(cycleCountListHref({ status: 'posted' })).toBe('/dashboard/cycle-counts');
  });
});

describe('cycleCountListHrefFromQuery', () => {
  it('keeps only the list parameters, so a stored value cannot point elsewhere', () => {
    expect(cycleCountListHrefFromQuery('?q=north&page=2&next=https://evil.test')).toBe(
      '/dashboard/cycle-counts?q=north&page=2',
    );
    expect(cycleCountListHrefFromQuery('//evil.test')).toBe('/dashboard/cycle-counts');
    expect(cycleCountListHrefFromQuery(null)).toBe('/dashboard/cycle-counts');
    expect(cycleCountListHrefFromQuery('page=abc&status=canceled')).toBe(
      '/dashboard/cycle-counts?status=canceled',
    );
  });
});

describe('list view memory', () => {
  it('the detail page returns to the search and page the list last showed', async () => {
    render(<RememberCycleCountListView q="CC-42" status={null} page={2} />);
    render(<BackToCycleCounts />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: '← Back to cycle counts' })).toHaveAttribute(
        'href',
        '/dashboard/cycle-counts?q=CC-42&page=2',
      ),
    );
  });

  it('falls back to the plain list when storage is unavailable', async () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<RememberCycleCountListView q="x" status={null} page={1} />);
    render(<BackToCycleCounts />);
    expect(screen.getByRole('link', { name: '← Back to cycle counts' })).toHaveAttribute(
      'href',
      '/dashboard/cycle-counts',
    );
  });
});
