import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ id: 'aaaaaaaaaaaa', builtAt: '2026-09-18T10:00:00.000Z' }));
vi.mock('@/lib/build-info', () => ({
  get LOADED_BUILD() {
    return build.id;
  },
  get LOADED_BUILT_AT() {
    return build.builtAt;
  },
}));
const capture = vi.fn();
vi.mock('@/lib/analytics', () => ({ capture: (...a: unknown[]) => capture(...a) }));
const reloadToBuild = vi.fn();
vi.mock('@/lib/updates/safe-reload', () => ({
  reloadToBuild: (...a: unknown[]) => reloadToBuild(...a),
  reconcileReload: () => 'none',
}));
let pathname = '/dashboard/inventory';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { registerUnsavedSource, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';
import { UNREAD_NOTICE_DELAY_MS, resetUpdateStoreForTests } from '@/lib/updates/update-store';

import { UpdateCenter } from './update-center';
import { WhatsNewButton } from './whats-new-button';

const summary = {
  id: 'september-2026',
  revision: 1,
  status: 'published',
  version: '2026.09',
  title: 'September improvements',
  summary: 'Faster staging.',
  publishedAt: '2026-09-18T17:00:00Z',
  entryCount: 1,
  state: { read: false, dismissed: false },
};
const entry = {
  id: 'staging',
  category: 'improved',
  area: 'Inventory',
  title: 'Find staged stock faster',
  whatChanged: 'A search box.',
  whyItMatters: 'Long lists.',
  howItAffectsYou: 'Type to narrow.',
  whatToDo: 'No action needed.',
  link: { href: '/dashboard/inventory/staging', label: 'Open Staging' },
};

const server = {
  served: 'aaaaaaaaaaaa',
  unread: true,
  posted: [] as Array<Record<string, unknown>>,
};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === '/api/version')
    return Response.json({
      build: server.served,
      builtAt: '2026-09-18T12:00:00.000Z',
      releasesKey: 'k1',
    });
  if (url === '/api/v1/me/releases') {
    const s = { ...summary, state: { read: !server.unread, dismissed: false } };
    return Response.json({
      releases: [s],
      unreadCount: server.unread ? 1 : 0,
      latestUnread: server.unread ? s : null,
      stateAvailable: true,
    });
  }
  if (url === '/api/v1/me/release-state') {
    server.posted.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, recorded: 1 });
  }
  if (url.startsWith('/api/v1/me/releases/'))
    return Response.json({ release: { ...summary, entries: [entry] } });
  return new Response('nf', { status: 404 });
});

async function settle(ms = 0) {
  await act(async () => {
    if (ms) vi.advanceTimersByTime(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  resetUpdateStoreForTests();
  resetUnsavedSourcesForTests();
  localStorage.clear();
  server.served = 'aaaaaaaaaaaa';
  server.unread = true;
  server.posted = [];
  build.id = 'aaaaaaaaaaaa';
  pathname = '/dashboard/inventory';
  fetchMock.mockClear();
  capture.mockClear();
  reloadToBuild.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
// No manual DOM wipe: the drawer renders in a portal, and clearing <body> before
// the testing library unmounts makes React remove nodes that are already gone.
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UpdateCenter', () => {
  it('a new production build shows EXACTLY ONE notice, with both actions, and steals no focus', async () => {
    server.served = 'bbbbbbbbbbbb';
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    expect(screen.getAllByRole('region', { name: 'Product update' })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { name: 'A new StockPilot update is available' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /what’s new/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh to update/i })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('announces politely through a live region that exists before the text does', async () => {
    const { container } = render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    const live = container.querySelector('[role="status"][aria-live="polite"]')!;
    expect(live).toBeTruthy();
    expect(live.textContent).toBe('');
    server.served = 'bbbbbbbbbbbb';
    await settle();
  });

  it('on the current version with unread notes: waits a beat, then offers What’s New with NO refresh', async () => {
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    expect(screen.queryByRole('region', { name: 'Product update' })).toBeNull();
    await settle(UNREAD_NOTICE_DELAY_MS + 10);
    expect(screen.getByRole('heading', { name: 'What’s new in StockPilot' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('nothing unread and nothing to refresh: says nothing at all', async () => {
    server.unread = false;
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle(UNREAD_NOTICE_DELAY_MS + 10);
    expect(screen.queryByRole('region', { name: 'Product update' })).toBeNull();
  });

  it('What’s New opens the correct release WITHOUT reloading, and only then is it read', async () => {
    server.served = 'bbbbbbbbbbbb';
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /what’s new/i }));
    await settle();
    expect(reloadToBuild).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'What’s New' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'September improvements' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Find staged stock faster' })).toBeInTheDocument();
    expect(server.posted.map((p) => p.action)).toEqual(['open', 'read']);
    // The notice steps aside while the drawer is up (it would sit over the footer).
    expect(screen.queryByRole('region', { name: 'Product update' })).toBeNull();
  });

  it('dismissing persists a dismissal and never a read; the permanent entry still shows unread', async () => {
    render(
      <>
        <WhatsNewButton />
        <UpdateCenter userId="user-1" organizationId="org-1" />
      </>,
    );
    await settle(UNREAD_NOTICE_DELAY_MS + 10);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    await settle();
    expect(server.posted).toEqual([{ action: 'dismiss', releaseId: 'september-2026' }]);
    expect(screen.queryByRole('region', { name: 'Product update' })).toBeNull();
    expect(screen.getByRole('button', { name: 'What’s new, 1 unread' })).toBeInTheDocument();
  });

  it('the permanent entry opens the drawer after the notice is gone', async () => {
    render(
      <>
        <WhatsNewButton />
        <UpdateCenter userId="user-1" organizationId="org-1" />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /^what’s new/i }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'What’s New' })).toBeInTheDocument();
    expect(
      capture.mock.calls.some(
        (c) =>
          c[0] === 'whats_new_opened' && (c[1] as { entryPoint: string }).entryPoint === 'topbar',
      ),
    ).toBe(true);
  });

  it('refresh is guarded: unsaved work blocks it, and Keep working preserves everything', async () => {
    server.served = 'bbbbbbbbbbbb';
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => true });
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /refresh to update/i }));
    await settle();
    expect(reloadToBuild).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Refresh StockPilot?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    await settle();
    expect(reloadToBuild).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: 'A new StockPilot update is available' }),
    ).toBeInTheDocument();
  });

  it('stops claiming unsaved work once it is saved: the card returns to normal and NEVER reloads by itself', async () => {
    server.served = 'bbbbbbbbbbbb';
    let dirty = true;
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => dirty });
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /refresh to update/i }));
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Refresh paused. You have unsaved changes in New item.',
    );

    dirty = false; // they saved the form on the page behind the card
    await settle(1_100);
    expect(screen.queryByRole('heading', { name: 'Refresh StockPilot?' })).toBeNull();
    expect(screen.getByRole('button', { name: /refresh to update/i })).toBeInTheDocument();
    expect(reloadToBuild).not.toHaveBeenCalled();
  });

  it('refresh with nothing unsaved reloads toward the served build', async () => {
    server.served = 'bbbbbbbbbbbb';
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /refresh to update/i }));
    expect(reloadToBuild).toHaveBeenCalledWith('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
  });

  it('yields to a product tour, and comes back when the tour ends', async () => {
    server.served = 'bbbbbbbbbbbb';
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    expect(screen.getByRole('region', { name: 'Product update' })).toBeInTheDocument();
    const tour = document.createElement('div');
    tour.setAttribute('data-tour-open', '');
    await act(async () => {
      document.body.appendChild(tour);
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByRole('region', { name: 'Product update' })).toBeNull();
    await act(async () => {
      tour.remove();
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByRole('region', { name: 'Product update' })).toBeInTheDocument();
  });

  it('a remount, route changes and repeated polling never produce a duplicate or a second impression', async () => {
    server.served = 'bbbbbbbbbbbb';
    const view = render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    pathname = '/dashboard/orders';
    view.rerender(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle(31_000);
    view.unmount();
    render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    expect(screen.getAllByRole('region', { name: 'Product update' })).toHaveLength(1);
    expect(capture.mock.calls.filter((c) => c[0] === 'update_notification_shown')).toHaveLength(1);
  });

  it('removes its timers and listeners when it unmounts for good', async () => {
    const view = render(<UpdateCenter userId="user-1" organizationId="org-1" />);
    await settle();
    view.unmount();
    const before = fetchMock.mock.calls.length;
    await settle(120_000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
