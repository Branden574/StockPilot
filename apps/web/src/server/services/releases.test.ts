import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Permission, Release } from '@stockpilot/core';

/**
 * The releases service decides WHICH release text a reader gets and WHOSE state
 * is written. Three failures are worth pinning:
 *   - an outage reading state must not become "everything is unread" for
 *     everybody (one notification per release per person);
 *   - a deep link must not confirm that a release the reader cannot see exists;
 *   - the client must never choose the revision it is marking read, or a stale
 *     tab could silence a deliberate re-announcement.
 */

const entry = (
  id: string,
  over: Partial<Release['entries'][number]> = {},
): Release['entries'][number] => ({
  id,
  category: 'improved',
  title: id,
  whatChanged: 'x',
  whyItMatters: 'x',
  howItAffectsYou: 'x',
  whatToDo: 'No action needed.',
  ...over,
});
const REGISTRY: Release[] = [
  {
    id: 'draft-one',
    revision: 1,
    status: 'draft',
    title: 'Draft',
    summary: 's',
    publishedAt: '2026-09-20T17:00:00Z',
    entries: [entry('a')],
  },
  {
    id: 'sept',
    revision: 3,
    status: 'published',
    title: 'September',
    summary: 's',
    publishedAt: '2026-09-18T17:00:00Z',
    entries: [entry('a')],
  },
  {
    id: 'approvers-only',
    revision: 1,
    status: 'published',
    title: 'Approvers',
    summary: 's',
    publishedAt: '2026-09-10T17:00:00Z',
    entries: [entry('a', { audience: { anyPermission: ['orders:approve'] } })],
  },
  {
    id: 'august',
    revision: 1,
    status: 'published',
    title: 'August',
    summary: 's',
    publishedAt: '2026-08-06T17:00:00Z',
    entries: [entry('a')],
  },
];
vi.mock('@/lib/releases/registry', () => ({
  get RELEASES() {
    return REGISTRY;
  },
}));

const reportError = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { getReleaseFor, listReleasesFor, recordReleaseState } from './releases';

const db = {
  stateRows: [] as Array<Record<string, unknown>>,
  stateError: null as { message: string } | null,
  createdAt: '2026-01-01T00:00:00Z' as string | null,
  profileError: null as { message: string } | null,
  rpc: vi.fn(),
};

function buildCtx(permissions: Permission[] = ['items:read']) {
  const supabase = {
    rpc: (...a: unknown[]) => db.rpc(...a),
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () =>
        db.profileError
          ? { data: null, error: db.profileError }
          : { data: db.createdAt ? { created_at: db.createdAt } : null, error: null };
      q.then = (resolve: (v: unknown) => void) =>
        resolve(
          table === 'user_release_state'
            ? { data: db.stateRows, error: db.stateError }
            : { data: null, error: null },
        );
      return q;
    },
  };
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'staff' as const,
    permissions: new Set<Permission>(permissions),
    enabledModules: new Set<ModuleId>(['inventory', 'orders']),
    supabase: supabase as never,
    mfaRequired: false,
    mfaSatisfied: true,
  };
}

beforeEach(() => {
  db.stateRows = [];
  db.stateError = null;
  db.createdAt = '2026-01-01T00:00:00Z';
  db.profileError = null;
  db.rpc.mockReset();
  db.rpc.mockResolvedValue({ data: null, error: null });
  reportError.mockClear();
});

describe('listReleasesFor', () => {
  it('sends what the reader may see, newest first, never a draft and never a release they cannot reach', async () => {
    const list = await listReleasesFor(buildCtx());
    expect(list.releases.map((r) => r.id)).toEqual(['sept', 'august']);
    expect(list.unreadCount).toBe(2);
    expect(list.latestUnread?.id).toBe('sept');
    expect(list.stateAvailable).toBe(true);
    expect(JSON.stringify(list)).not.toContain('audience');
  });

  it('shows more to a reader with the permission', async () => {
    const list = await listReleasesFor(buildCtx(['items:read', 'orders:approve']));
    expect(list.releases.map((r) => r.id)).toEqual(['sept', 'approvers-only', 'august']);
  });

  it('honours read state at the CURRENT revision only', async () => {
    db.stateRows = [
      {
        release_id: 'sept',
        revision: 2,
        dismissed_at: null,
        opened_at: 'x',
        read_at: '2026-09-19T00:00:00Z',
      },
      {
        release_id: 'august',
        revision: 1,
        dismissed_at: null,
        opened_at: 'x',
        read_at: '2026-08-07T00:00:00Z',
      },
    ];
    const list = await listReleasesFor(buildCtx());
    // sept was read at revision 2; the registry is at 3: unread again.
    expect(list.releases.find((r) => r.id === 'sept')!.state.read).toBe(false);
    expect(list.releases.find((r) => r.id === 'august')!.state.read).toBe(true);
    expect(list.unreadCount).toBe(1);
  });

  it('gives a brand-new member no backlog', async () => {
    db.createdAt = '2026-09-19T00:00:00Z';
    const list = await listReleasesFor(buildCtx());
    expect(list.unreadCount).toBe(0);
    expect(list.latestUnread).toBeNull();
    expect(list.releases).toHaveLength(2);
  });

  it('an OUTAGE reading state offers nothing and marks nothing unread, and is reported', async () => {
    db.stateError = { message: 'relation "user_release_state" does not exist' };
    const list = await listReleasesFor(buildCtx());
    expect(list.stateAvailable).toBe(false);
    expect(list.unreadCount).toBe(0);
    expect(list.latestUnread).toBeNull();
    expect(list.releases.every((r) => r.state.read)).toBe(true);
    expect(list.releases.map((r) => r.id)).toEqual(['sept', 'august']);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ tag: 'releases.load-state' });
  });

  it('a failed BASELINE read is an outage too: it must not hand a newer member the whole history', async () => {
    // supabase-js does not throw here. It answers { data: null, error }, and a
    // null baseline means "no baseline": everything published, ever, is unread.
    db.profileError = { message: 'upstream request timeout' };
    const list = await listReleasesFor(buildCtx());
    expect(list.stateAvailable).toBe(false);
    expect(list.unreadCount).toBe(0);
    expect(list.latestUnread).toBeNull();
    expect(reportError.mock.calls[0]![1]).toMatchObject({ tag: 'releases.load-state' });
  });

  it('a profile row that is genuinely absent is not an outage', async () => {
    db.createdAt = null;
    const list = await listReleasesFor(buildCtx());
    expect(list.stateAvailable).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('ignores malformed state rows instead of trusting them', async () => {
    db.stateRows = [
      null as never,
      { release_id: 7 },
      { release_id: 'sept', revision: '3', read_at: 'x' },
    ];
    const list = await listReleasesFor(buildCtx());
    expect(list.unreadCount).toBe(2);
  });
});

describe('getReleaseFor', () => {
  it('returns the release with audience stripped', async () => {
    const r = await getReleaseFor(buildCtx(), 'sept');
    expect(r?.id).toBe('sept');
    expect(r?.entries).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('audience');
  });

  it('answers null alike for unknown, draft, and not-for-you: a deep link confirms nothing', async () => {
    expect(await getReleaseFor(buildCtx(), 'no-such-release')).toBeNull();
    expect(await getReleaseFor(buildCtx(), 'draft-one')).toBeNull();
    expect(await getReleaseFor(buildCtx(), 'approvers-only')).toBeNull();
    expect(await getReleaseFor(buildCtx(['orders:approve']), 'approvers-only')).not.toBeNull();
  });
});

describe('recordReleaseState', () => {
  it('records against the SERVER’S revision, as the caller, naming no user', async () => {
    const res = await recordReleaseState(buildCtx(), { action: 'read', releaseId: 'sept' });
    expect(res).toEqual({ ok: true, recorded: 1 });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('record_release_state', {
      p_release_id: 'sept',
      p_revision: 3,
      p_action: 'read',
    });
  });

  it('passes dismiss and open through as themselves: dismissing is not reading', async () => {
    await recordReleaseState(buildCtx(), { action: 'dismiss', releaseId: 'sept' });
    await recordReleaseState(buildCtx(), { action: 'open', releaseId: 'sept' });
    expect(db.rpc.mock.calls.map((c) => (c[1] as { p_action: string }).p_action)).toEqual([
      'dismiss',
      'open',
    ]);
  });

  it('writes nothing for a release the reader cannot see, and does not say why', async () => {
    expect(
      await recordReleaseState(buildCtx(), { action: 'read', releaseId: 'approvers-only' }),
    ).toEqual({ ok: true, recorded: 0 });
    expect(
      await recordReleaseState(buildCtx(), { action: 'read', releaseId: 'draft-one' }),
    ).toEqual({ ok: true, recorded: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('read_all marks exactly the visible UNREAD releases, each at its own revision', async () => {
    db.stateRows = [
      {
        release_id: 'august',
        revision: 1,
        dismissed_at: null,
        opened_at: 'x',
        read_at: '2026-08-07T00:00:00Z',
      },
    ];
    const res = await recordReleaseState(buildCtx(['items:read', 'orders:approve']), {
      action: 'read_all',
    });
    expect(res).toEqual({ ok: true, recorded: 2 });
    expect(db.rpc.mock.calls.map((c) => c[1])).toEqual([
      { p_release_id: 'sept', p_revision: 3, p_action: 'read' },
      { p_release_id: 'approvers-only', p_revision: 1, p_action: 'read' },
    ]);
  });

  it('reports a failed write and tells the caller, instead of pretending it saved', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    expect(await recordReleaseState(buildCtx(), { action: 'read', releaseId: 'sept' })).toEqual({
      ok: false,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    db.rpc.mockRejectedValue(new Error('fetch failed'));
    expect(await recordReleaseState(buildCtx(), { action: 'read', releaseId: 'sept' })).toEqual({
      ok: false,
    });
  });

  it('read_all refuses to guess when state cannot be loaded', async () => {
    db.stateError = { message: 'boom' };
    expect(await recordReleaseState(buildCtx(), { action: 'read_all' })).toEqual({ ok: false });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
