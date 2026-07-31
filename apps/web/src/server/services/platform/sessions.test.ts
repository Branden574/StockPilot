import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The repo's only prior by-user-id sign-out (team.ts) passed a uuid to
 * auth-js's signOut(jwt, scope), which takes a JWT. It could never have worked.
 * These pin the replacement: one RPC, one user id, ids returned, a live
 * eviction broadcast that only fires once the revoke actually landed, and a
 * failure that reports rather than throws.
 */

const rpc = vi.fn();
// Rest-typed so the pass-through wrappers below spread into them cleanly
// (a zero-arg vi.fn() is not a valid spread target under `tsc --noEmit`).
const reportError = vi.fn(async (..._args: unknown[]) => {});
const broadcastToChannel = vi.fn(async (..._args: unknown[]) => {});

vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
}));

import { revokeAllSessionsForUser } from './sessions';

const USER = '55555555-5555-5555-5555-555555555555';

describe('revokeAllSessionsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: ['s-1', 's-2'], error: null });
  });

  it('calls the admin RPC with the target user id and returns the revoked ids', async () => {
    const res = await revokeAllSessionsForUser(USER);

    // The 0308 function's parameter is `p_target_user_id` (the repo convention
    // — see revoke_my_session(p_session_id)). PostgREST matches named args
    // EXACTLY, so a bare `target_user_id` here would 404 "function not found"
    // at runtime and silently degrade to ok:false forever.
    expect(rpc).toHaveBeenCalledWith('admin_revoke_user_sessions', { p_target_user_id: USER });
    expect(res).toEqual({ ok: true, sessionIds: ['s-1', 's-2'] });
  });

  it('reports ok with zero ids when the user had no live sessions', async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    expect(await revokeAllSessionsForUser(USER)).toEqual({ ok: true, sessionIds: [] });
  });

  it('never throws when the RPC fails — it reports and returns ok:false', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const res = await revokeAllSessionsForUser(USER);

    expect(res).toEqual({ ok: false, sessionIds: [] });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null data payload', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    expect(await revokeAllSessionsForUser(USER)).toEqual({ ok: true, sessionIds: [] });
  });

  it('accepts row-shaped RPC output as well as bare uuids', async () => {
    rpc.mockResolvedValue({ data: [{ id: 's-1' }, { id: 's-2' }], error: null });

    expect(await revokeAllSessionsForUser(USER)).toEqual({
      ok: true,
      sessionIds: ['s-1', 's-2'],
    });
  });
});

describe('revokeAllSessionsForUser — live eviction broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: ['s-1', 's-2'], error: null });
  });

  it('evicts every live device on the device-management channel', async () => {
    await revokeAllSessionsForUser(USER);

    // Exact channel/event/payload contract of the device-management feature.
    // `keepId: null` is the "sign out EVERYWHERE" shape (server/actions/auth.ts
    // uses it for global sign-out and password reset): the listeners treat any
    // payload with a `keepId` that isn't their own session id as targeting
    // them, so null targets all of them. The `sessionIds` shape would be wrong
    // here — a device whose JWT names a session row that was already gone
    // would not match and would coast to token expiry.
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith(`user:${USER}:sessions`, 'revoked', {
      keepId: null,
    });
  });

  it('broadcasts AFTER the revoke, never before it', async () => {
    await revokeAllSessionsForUser(USER);

    // Order matters: the listener answers with signOut({ scope: 'local' }),
    // which is only safe because the server side already deleted the rows. A
    // broadcast that raced ahead of the RPC could sign a device out while its
    // session was still live and refreshable.
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(
      broadcastToChannel.mock.invocationCallOrder[0]!,
    );
  });

  it('does not evict anyone when the revoke failed', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    await revokeAllSessionsForUser(USER);

    // Nothing was revoked, so signing devices out would be a lie: they would
    // bounce to /signin and immediately sign back in on a session that is
    // still live.
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('still reports ok when the revoke landed but the broadcast blew up', async () => {
    broadcastToChannel.mockRejectedValueOnce(new Error('realtime down'));

    // Best-effort UX: the authoritative revoke already happened, so a dead
    // socket must degrade to "the device coasts until its access token
    // expires", not to a failed operation.
    expect(await revokeAllSessionsForUser(USER)).toEqual({
      ok: true,
      sessionIds: ['s-1', 's-2'],
    });
  });
});

// The old, broken mechanism must not survive anywhere.
describe('the broken by-user-id signOut is gone', () => {
  const src = readFileSync(join(__dirname, '../team.ts'), 'utf8');
  // Comment lines are stripped before the check: the replacement deliberately
  // quotes the old `admin.auth.admin.signOut(removedUserId, 'global')` call in
  // prose so the archaeology survives, and a plain substring search over the
  // whole file would flag that explanation as the bug it documents. Executable
  // lines are compared verbatim, so a real call is still caught.
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('team.ts no longer calls auth.admin.signOut', () => {
    expect(code).not.toContain('auth.admin.signOut');
  });

  it('team.ts revokes through the supported helper instead', () => {
    expect(src).toContain('revokeAllSessionsForUser');
  });
});
