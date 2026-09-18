import 'server-only';

import {
  ROLE_PERMISSIONS,
  type ClientRelease,
  type ClientReleaseList,
  type Permission,
  type ReleaseStateAction,
  type ReleaseViewer,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import {
  buildReleaseList,
  isUnread,
  toClientRelease,
  toClientSummary,
  visibleReleases,
  type ReleaseStateRow,
} from '@/lib/releases/logic';
import { RELEASES } from '@/lib/releases/registry';

import type { ServiceContext } from './context';

/**
 * Product releases ("What's New") for ONE reader.
 *
 * Content comes from the repository registry, so there is nothing to authorize
 * about the text itself: what is authorized is WHICH of it a reader gets
 * (audience, evaluated here from the verified context, never from the client)
 * and WHOSE state is touched (always the context's own user, through own-row
 * RLS; no function here accepts a user id).
 *
 * Every read degrades instead of throwing. A release-notes outage must never
 * take a page down, and above all must never turn into "everything is unread"
 * for everybody: when state cannot be loaded, releases go out as READ with
 * nothing offered, and the failure is reported.
 */

export function releaseViewerFor(ctx: ServiceContext): ReleaseViewer {
  return {
    role: ctx.role,
    // Synthetic contexts (cron, tests) omit the effective set; the static role
    // defaults are the documented fallback (see ServiceContext.permissions).
    permissions: ctx.permissions ?? new Set<Permission>(ROLE_PERMISSIONS[ctx.role]),
    enabledModules: ctx.enabledModules ?? new Set(),
  };
}

interface LoadedState {
  rows: ReleaseStateRow[];
  baselineIso: string | null;
  available: boolean;
}

async function loadState(ctx: ServiceContext): Promise<LoadedState> {
  try {
    const [state, profile] = await Promise.all([
      ctx.supabase
        .from('user_release_state')
        .select('release_id, revision, dismissed_at, opened_at, read_at')
        .eq('user_id', ctx.userId),
      ctx.supabase.from('user_profiles').select('created_at').eq('id', ctx.userId).maybeSingle(),
    ]);
    if (state.error) throw new Error(state.error.message);
    // The baseline is PART of the state. supabase-js reports a failed read as
    // `{ data: null, error }` rather than throwing, and a missing baseline means
    // "no baseline": for a newer member that turns the whole history unread,
    // which is the one outcome this service exists to prevent. A failed read
    // degrades like any other (everything read, nothing offered). A profile row
    // that is genuinely absent (data null, no error) keeps the old behaviour.
    if (profile.error) throw new Error(profile.error.message);
    const rows = ((state.data ?? []) as unknown[]).flatMap((raw): ReleaseStateRow[] => {
      if (raw === null || typeof raw !== 'object') return [];
      const r = raw as Record<string, unknown>;
      if (typeof r.release_id !== 'string' || typeof r.revision !== 'number') return [];
      const ts = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
      return [
        {
          release_id: r.release_id,
          revision: r.revision,
          dismissed_at: ts(r.dismissed_at),
          opened_at: ts(r.opened_at),
          read_at: ts(r.read_at),
        },
      ];
    });
    const created = (profile.data as { created_at?: unknown } | null)?.created_at;
    return { rows, baselineIso: typeof created === 'string' ? created : null, available: true };
  } catch (err) {
    await reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'releases.load-state',
      level: 'warning',
      extra: { userId: ctx.userId },
    });
    return { rows: [], baselineIso: null, available: false };
  }
}

/** Everything the reader may see, newest first, with their read state. */
export async function listReleasesFor(ctx: ServiceContext): Promise<ClientReleaseList> {
  const viewer = releaseViewerFor(ctx);
  const state = await loadState(ctx);
  if (!state.available) {
    const releases = visibleReleases(RELEASES, viewer).map((r) => ({
      ...toClientSummary(r, undefined, null),
      state: { read: true, dismissed: false },
    }));
    return { releases, unreadCount: 0, latestUnread: null, stateAvailable: false };
  }
  return {
    ...buildReleaseList(RELEASES, viewer, state.rows, state.baselineIso),
    stateAvailable: true,
  };
}

/**
 * One release the reader may see, or null. Null covers "does not exist",
 * "is a draft" and "is not for you" alike: a deep link must not be able to
 * confirm that a release the reader cannot see exists.
 */
export async function getReleaseFor(
  ctx: ServiceContext,
  slug: string,
): Promise<ClientRelease | null> {
  const release = visibleReleases(RELEASES, releaseViewerFor(ctx)).find((r) => r.id === slug);
  if (!release) return null;
  const state = await loadState(ctx);
  const row = state.rows.find((r) => r.release_id === slug);
  const client = toClientRelease(release, row, state.baselineIso);
  return state.available ? client : { ...client, state: { read: true, dismissed: false } };
}

export type RecordResult = { ok: true; recorded: number } | { ok: false };

/**
 * Record dismiss / open / read for the context's own user. The release must be
 * one the reader can see, and the REVISION comes from the server's registry,
 * never from the client: a stale tab cannot mark a re-announcement read by
 * claiming the new revision.
 */
export async function recordReleaseState(
  ctx: ServiceContext,
  action: ReleaseStateAction,
): Promise<RecordResult> {
  const viewer = releaseViewerFor(ctx);
  const visible = visibleReleases(RELEASES, viewer);

  let targets: Array<{ id: string; revision: number }>;
  let verb: 'dismiss' | 'open' | 'read';
  if (action.action === 'read_all') {
    const state = await loadState(ctx);
    if (!state.available) return { ok: false };
    const byId = new Map(state.rows.map((r) => [r.release_id, r]));
    targets = visible
      .filter((r) => isUnread(r, byId.get(r.id), state.baselineIso))
      .map((r) => ({ id: r.id, revision: r.revision }));
    verb = 'read';
  } else {
    const release = visible.find((r) => r.id === action.releaseId);
    // Not visible (or gone): nothing to record. Not an error the client can use.
    if (!release) return { ok: true, recorded: 0 };
    targets = [{ id: release.id, revision: release.revision }];
    verb = action.action;
  }

  try {
    const results = await Promise.all(
      targets.map((t) =>
        ctx.supabase.rpc('record_release_state', {
          p_release_id: t.id,
          p_revision: t.revision,
          p_action: verb,
        }),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw new Error(failed.error.message);
    return { ok: true, recorded: targets.length };
  } catch (err) {
    await reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'releases.record-state',
      level: 'warning',
      extra: { userId: ctx.userId, action: action.action, targets: targets.length },
    });
    return { ok: false };
  }
}
