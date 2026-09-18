import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  one: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({ userId: 'user-1', role: 'staff' })),
}));
vi.mock('@/server/services/releases', () => ({
  listReleasesFor: (...a: unknown[]) => h.list(...a),
  getReleaseFor: (...a: unknown[]) => h.one(...a),
}));
vi.mock('next/navigation', () => ({
  notFound: () => h.notFound(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));
const markReleaseRead = vi.fn(async () => true);
vi.mock('@/lib/updates/update-store', () => ({
  markAllRead: vi.fn(async () => true),
  markReleaseRead: (...a: unknown[]) => markReleaseRead(...(a as [])),
}));

import WhatsNewReleasePage, { generateMetadata } from './[slug]/page';
import WhatsNewHistoryPage from './page';

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  status: 'published',
  title: `Release ${id}`,
  summary: `Summary of ${id}.`,
  publishedAt: '2026-09-18T17:00:00Z',
  entryCount: 2,
  state: { read: true, dismissed: false },
  ...over,
});
const entry = {
  id: 'e1',
  category: 'improved',
  title: 'Find staged stock faster',
  whatChanged: 'A search box.',
  whyItMatters: 'Long lists.',
  howItAffectsYou: 'Type to narrow.',
  whatToDo: 'No action needed.',
  link: { href: '/dashboard/inventory/staging', label: 'Open Staging' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({
    releases: [
      summary('newest', { state: { read: false, dismissed: true } }),
      summary('older'),
      summary('pulled', { status: 'withdrawn' }),
    ],
    unreadCount: 1,
    latestUnread: null,
    stateAvailable: true,
  });
});

describe('release history', () => {
  it('lists releases newest first with links to each, exactly as the server ordered them', async () => {
    render(await WhatsNewHistoryPage());
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => within(li).getByRole('heading').textContent)).toEqual([
      'Release newest',
      'Release older',
      'Release pulled',
    ]);
    expect(within(items[0]!).getByRole('link')).toHaveAttribute(
      'href',
      '/dashboard/whats-new/newest',
    );
  });

  it('marks unread with a TEXT label, not colour alone, and only where it is true', async () => {
    render(await WhatsNewHistoryPage());
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('Unread')).toBeInTheDocument();
    expect(within(items[1]!).queryByText('Unread')).toBeNull();
    expect(within(items[2]!).getByText('Withdrawn')).toBeInTheDocument();
  });

  it('offers Mark all as read as an explicit action, and only when something is unread', async () => {
    render(await WhatsNewHistoryPage());
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeInTheDocument();
  });

  it('hides it when nothing is unread', async () => {
    h.list.mockResolvedValue({
      releases: [summary('older')],
      unreadCount: 0,
      latestUnread: null,
      stateAvailable: true,
    });
    render(await WhatsNewHistoryPage());
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
  });

  it('says so when read state could not be loaded, instead of showing confident dots', async () => {
    h.list.mockResolvedValue({
      releases: [summary('older')],
      unreadCount: 0,
      latestUnread: null,
      stateAvailable: false,
    });
    render(await WhatsNewHistoryPage());
    expect(screen.getByRole('status')).toHaveTextContent(
      'could not load which releases you have read',
    );
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
  });

  it('has an honest empty state', async () => {
    h.list.mockResolvedValue({
      releases: [],
      unreadCount: 0,
      latestUnread: null,
      stateAvailable: true,
    });
    render(await WhatsNewHistoryPage());
    expect(screen.getByText('There are no release notes for you yet.')).toBeInTheDocument();
  });
});

describe('one release by its own URL', () => {
  const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

  it('is a complete page: identity, highlights and every change, with a way back', async () => {
    h.one.mockResolvedValue({
      ...summary('newest', { state: { read: false, dismissed: false } }),
      entries: [entry],
    });
    render(await WhatsNewReleasePage(params('newest')));
    expect(screen.getByRole('heading', { level: 1, name: 'Release newest' })).toBeInTheDocument();
    expect(screen.getByText('Summary of newest.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Find staged stock faster' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /release history/i })).toHaveAttribute(
      'href',
      '/dashboard/whats-new',
    );
  });

  it('records READ because it rendered after an intentional open, and not when already read', async () => {
    h.one.mockResolvedValue({
      ...summary('newest', { state: { read: false, dismissed: false } }),
      entries: [entry],
    });
    render(await WhatsNewReleasePage(params('newest')));
    expect(markReleaseRead).toHaveBeenCalledWith('newest');
    markReleaseRead.mockClear();
    h.one.mockResolvedValue({ ...summary('older'), entries: [entry] });
    render(await WhatsNewReleasePage(params('older')));
    expect(markReleaseRead).not.toHaveBeenCalled();
  });

  it('404s alike for a release that does not exist and one that is not for this reader', async () => {
    h.one.mockResolvedValue(null);
    await expect(WhatsNewReleasePage(params('approvers-only'))).rejects.toThrow('NEXT_NOT_FOUND');
    // The tab title confirms nothing either.
    expect(await generateMetadata(params('approvers-only'))).toEqual({ title: 'What’s new' });
  });

  it('a withdrawn release explains itself, shows no changes, and is never marked read', async () => {
    h.one.mockResolvedValue({
      ...summary('pulled', { status: 'withdrawn', state: { read: true, dismissed: false } }),
      withdrawnNote: 'Rolled back.',
      entries: [],
    });
    render(await WhatsNewReleasePage(params('pulled')));
    expect(screen.getByText('Rolled back.')).toBeInTheDocument();
    expect(screen.queryByText('Highlights')).toBeNull();
    expect(markReleaseRead).not.toHaveBeenCalled();
  });
});
