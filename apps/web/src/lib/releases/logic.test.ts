import { describe, expect, it } from 'vitest';

import type { Release, ReleaseViewer } from '@stockpilot/core';

import {
  buildReleaseList,
  isUnread,
  registryFingerprint,
  legacyAnnouncementsFor,
  toClientRelease,
  visibleReleases,
  type ReleaseStateRow,
} from './logic';

const entry = (
  id: string,
  over: Partial<Release['entries'][number]> = {},
): Release['entries'][number] => ({
  id,
  category: 'improved',
  title: `Entry ${id}`,
  whatChanged: 'Something changed.',
  whyItMatters: 'It matters.',
  howItAffectsYou: 'It affects you.',
  whatToDo: 'No action needed.',
  ...over,
});

const release = (id: string, publishedAt: string, over: Partial<Release> = {}): Release => ({
  id,
  revision: 1,
  status: 'published',
  title: `Release ${id}`,
  summary: `Summary of ${id}.`,
  publishedAt,
  entries: [entry('a')],
  ...over,
});

const staff: ReleaseViewer = {
  role: 'staff',
  permissions: new Set(['items:read', 'orders:request'] as const),
  enabledModules: new Set(['inventory', 'orders'] as const),
};
const manager: ReleaseViewer = {
  role: 'manager',
  permissions: new Set(['items:read', 'orders:request', 'orders:approve'] as const),
  enabledModules: new Set(['inventory', 'orders'] as const),
};

const row = (release_id: string, over: Partial<ReleaseStateRow> = {}): ReleaseStateRow => ({
  release_id,
  revision: 1,
  dismissed_at: null,
  opened_at: null,
  read_at: null,
  ...over,
});

describe('visibleReleases', () => {
  it('never lets a draft leave the server', () => {
    expect(
      visibleReleases([release('d', '2026-09-18T00:00:00Z', { status: 'draft' })], manager),
    ).toEqual([]);
  });

  it('drops entries the reader cannot reach, and a release left with none', () => {
    const r = release('mixed', '2026-09-18T00:00:00Z', {
      entries: [
        entry('for-all'),
        entry('approvers', { audience: { anyPermission: ['orders:approve'] } }),
      ],
    });
    expect(visibleReleases([r], manager)[0]!.entries.map((e) => e.id)).toEqual([
      'for-all',
      'approvers',
    ]);
    expect(visibleReleases([r], staff)[0]!.entries.map((e) => e.id)).toEqual(['for-all']);

    const onlyApprovers = release('gated', '2026-09-18T00:00:00Z', {
      entries: [entry('approvers', { audience: { anyPermission: ['orders:approve'] } })],
    });
    expect(visibleReleases([onlyApprovers], staff)).toEqual([]);
  });

  it('honours the release-level audience', () => {
    const r = release('schedule', '2026-09-18T00:00:00Z', { audience: { modules: ['schedule'] } });
    expect(visibleReleases([r], manager)).toEqual([]);
  });

  it('keeps a withdrawn release in history WITHOUT its entries or links', () => {
    const r = release('pulled', '2026-09-18T00:00:00Z', {
      status: 'withdrawn',
      withdrawnNote: 'Rolled back while we fix an issue.',
      entries: [entry('a', { link: { href: '/dashboard/orders', label: 'Open' } })],
    });
    const [seen] = visibleReleases([r], manager);
    expect(seen!.status).toBe('withdrawn');
    expect(seen!.entries).toEqual([]);
  });

  it('keeps registry order and never re-sorts', () => {
    const list = [
      release('second-of-day', '2026-09-01T00:00:00Z'),
      release('first-of-day', '2026-09-01T00:00:00Z'),
    ];
    expect(visibleReleases(list, manager).map((r) => r.id)).toEqual([
      'second-of-day',
      'first-of-day',
    ]);
  });
});

describe('isUnread', () => {
  const r = release('sept', '2026-09-18T17:00:00Z');
  const BEFORE = '2026-01-01T00:00:00Z';

  it('is unread until read', () => {
    expect(isUnread(r, undefined, BEFORE)).toBe(true);
    expect(isUnread(r, row('sept', { read_at: '2026-09-19T00:00:00Z' }), BEFORE)).toBe(false);
  });

  it('opening or dismissing is NOT reading', () => {
    expect(isUnread(r, row('sept', { opened_at: '2026-09-19T00:00:00Z' }), BEFORE)).toBe(true);
    expect(isUnread(r, row('sept', { dismissed_at: '2026-09-19T00:00:00Z' }), BEFORE)).toBe(true);
  });

  it('a typo fix does not un-read it; a deliberate re-announcement does', () => {
    const read = row('sept', { revision: 1, read_at: '2026-09-19T00:00:00Z' });
    expect(isUnread({ ...r, title: 'Fixed a typo' }, read, BEFORE)).toBe(false);
    expect(isUnread({ ...r, revision: 2 }, read, BEFORE)).toBe(true);
  });

  it('no backlog: a release from before the account existed counts as read', () => {
    expect(isUnread(r, undefined, '2026-10-01T00:00:00Z')).toBe(false);
    expect(isUnread(r, undefined, '2026-09-18T16:59:59Z')).toBe(true);
    // An unknown baseline must not hide news.
    expect(isUnread(r, undefined, null)).toBe(true);
    expect(isUnread(r, undefined, 'not-a-date')).toBe(true);
  });

  it('a withdrawn release is never unread', () => {
    expect(isUnread({ ...r, status: 'withdrawn', withdrawnNote: 'x' }, undefined, BEFORE)).toBe(
      false,
    );
  });
});

describe('buildReleaseList', () => {
  const list = [
    release('c', '2026-09-18T00:00:00Z'),
    release('b', '2026-09-10T00:00:00Z'),
    release('a', '2026-09-01T00:00:00Z'),
  ];
  const BEFORE = '2026-01-01T00:00:00Z';

  it('several missed releases make ONE prompt, for the newest', () => {
    const out = buildReleaseList(list, manager, [], BEFORE);
    expect(out.unreadCount).toBe(3);
    expect(out.latestUnread?.id).toBe('c');
  });

  it('dismissing the newest offers NOTHING more: no drip through the backlog, and nothing is marked read', () => {
    const out = buildReleaseList(
      list,
      manager,
      [row('c', { dismissed_at: '2026-09-18T01:00:00Z' })],
      BEFORE,
    );
    expect(out.unreadCount).toBe(3);
    // NOT 'b'. Falling through to the next unread release turns one "not now"
    // into a prompt per missed release.
    expect(out.latestUnread).toBeNull();
    expect(out.releases[0]!.state).toEqual({ read: false, dismissed: true });
  });

  it('a release NEWER than the dismissed one prompts again', () => {
    const newer = [release('d', '2026-09-20T00:00:00Z'), ...list];
    const out = buildReleaseList(
      newer,
      manager,
      [row('c', { dismissed_at: '2026-09-18T01:00:00Z' })],
      BEFORE,
    );
    expect(out.latestUnread?.id).toBe('d');
  });

  it('reading the newest moves the offer to the next unread, because that one was never dismissed', () => {
    const out = buildReleaseList(
      list,
      manager,
      [row('c', { read_at: '2026-09-19T00:00:00Z' })],
      BEFORE,
    );
    expect(out.latestUnread?.id).toBe('b');
  });

  it('a dismissal recorded against an older revision does not silence a re-announcement', () => {
    const reannounced = [{ ...list[0]!, revision: 2 }, list[1]!, list[2]!];
    const out = buildReleaseList(
      reannounced,
      manager,
      [row('c', { revision: 1, dismissed_at: '2026-09-18T01:00:00Z' })],
      BEFORE,
    );
    expect(out.latestUnread?.id).toBe('c');
  });

  it('offers nothing when everything is read', () => {
    const rows = list.map((r) => row(r.id, { read_at: '2026-09-19T00:00:00Z' }));
    const out = buildReleaseList(list, manager, rows, BEFORE);
    expect(out.unreadCount).toBe(0);
    expect(out.latestUnread).toBeNull();
  });
});

describe('toClientRelease', () => {
  it('strips audience from the release AND from every entry', () => {
    const r = release('gated', '2026-09-18T00:00:00Z', {
      audience: { roles: ['manager'] },
      entries: [entry('a', { audience: { anyPermission: ['orders:approve'] } })],
    });
    const json = JSON.stringify(toClientRelease(r, undefined, null));
    expect(json).not.toContain('audience');
    expect(json).not.toContain('orders:approve');
    expect(json).not.toContain('"roles"');
  });
});

describe('registryFingerprint', () => {
  const live = release('live', '2026-09-18T00:00:00Z');

  it('ignores drafts, so preparing one changes nothing a client can observe', () => {
    const draft = release('draft', '2026-09-20T00:00:00Z', { status: 'draft' });
    expect(registryFingerprint([draft, live])).toBe(registryFingerprint([live]));
    expect(registryFingerprint([draft])).toBe('');
    expect(registryFingerprint([])).toBe('');
  });

  it('changes on a new release, a re-announcement and a withdrawal', () => {
    const base = registryFingerprint([live]);
    const older = release('older', '2026-08-01T00:00:00Z');
    expect(registryFingerprint([live, older])).not.toBe(base);
    expect(registryFingerprint([{ ...live, revision: live.revision + 1 }])).not.toBe(base);
    expect(registryFingerprint([{ ...live, status: 'withdrawn', withdrawnNote: 'x' }])).not.toBe(
      base,
    );
  });
});

describe('legacyAnnouncementsFor (mobile builds already in the field)', () => {
  const list = ['e', 'd', 'c', 'b', 'a'].map((id, i) =>
    release(id, `2026-09-${String(18 - i).padStart(2, '0')}T17:00:00Z`, {
      entries: [entry('x', { link: { href: '/dashboard/orders', label: 'View orders' } })],
    }),
  );

  it('returns the exact legacy shape, every text field a string', () => {
    const [first] = legacyAnnouncementsFor(list, manager, {});
    expect(first).toEqual({
      id: 'e',
      date: '2026-09-18',
      title: 'Release e',
      body: 'Summary of e.',
      cta: { href: '/dashboard/orders', label: 'View orders' },
    });
  });

  it('caps at 3, in registry order, skipping ids already in the seen map', () => {
    expect(legacyAnnouncementsFor(list, manager, {}).map((a) => a.id)).toEqual(['e', 'd', 'c']);
    expect(
      legacyAnnouncementsFor(list, manager, { e: { at: 'x', outcome: 'seen' }, c: true }).map(
        (a) => a.id,
      ),
    ).toEqual(['d', 'b', 'a']);
  });

  it('omits the cta key entirely when the reader can reach no linked entry', () => {
    const r = release('nolink', '2026-09-18T17:00:00Z');
    expect(legacyAnnouncementsFor([r], manager, {})[0]).not.toHaveProperty('cta');
  });

  it('never sends a draft, a withdrawn release, or one the reader cannot reach', () => {
    const mixed = [
      release('draft', '2026-09-20T00:00:00Z', { status: 'draft' }),
      release('pulled', '2026-09-19T00:00:00Z', { status: 'withdrawn', withdrawnNote: 'x' }),
      release('approvers', '2026-09-18T00:00:00Z', {
        audience: { anyPermission: ['orders:approve'] },
      }),
      release('everyone', '2026-09-17T00:00:00Z'),
    ];
    expect(legacyAnnouncementsFor(mixed, staff, {}).map((a) => a.id)).toEqual(['everyone']);
  });
});
