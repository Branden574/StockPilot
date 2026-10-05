/**
 * Settings > Public requests server-renders the links, and each prints its
 * expiry and creation day with toLocaleDateString(): the server's zone (UTC
 * on Vercel) while it renders, the viewer's while the browser hydrates. An
 * evening in Los Angeles is the next day in UTC, so React threw error #418.
 * The days are printed once the page has hydrated.
 */
import { within } from '@testing-library/react';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

import type { PublicLinkRow } from '@/server/services/public-links';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/actions/public-links', () => ({
  createPublicLinkAction: vi.fn(),
  duplicatePublicLinkAction: vi.fn(),
  setPublicLinkActiveAction: vi.fn(),
}));

import { PublicLinksManager } from './public-links-manager';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');
// Evenings in Los Angeles: Nov 30 and Oct 5 there, Dec 1 and Oct 6 in UTC.
const EXPIRES_AT = '2026-12-01T02:30:00.000Z';
const CREATED_AT = '2026-10-06T02:30:00.000Z';

const LINK: PublicLinkRow = {
  id: 'l1',
  name: 'Fall supplies',
  purpose: null,
  instructions: null,
  active: true,
  expires_at: EXPIRES_AT,
  available_from: null,
  available_until: null,
  availability_display: 'exact',
  books_enabled: true,
  items_enabled: true,
  include_public_pool: false,
  default_max_qty: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  entry_count: 3,
};

describe('PublicLinksManager hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints the viewer's expiry and creation days once hydrated, never the server's, with no hydration error", async () => {
    const day = (zone: string, iso: string) =>
      inZone(zone, () => new Date(iso).toLocaleDateString());
    const run = await hydrateAcrossClockShift(
      () => <PublicLinksManager appUrl="https://stockpilotusa.com" links={[LINK]} />,
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).toContain('Fall supplies');
      expect(run.html).not.toContain(day('UTC', EXPIRES_AT));
      expect(run.html).not.toContain(day('UTC', CREATED_AT));
      const page = within(run.container);
      expect(page.getByText(day(BROWSER_ZONE, EXPIRES_AT))).toBeInTheDocument();
      expect(page.getByText(day(BROWSER_ZONE, CREATED_AT))).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
