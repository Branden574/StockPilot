// SessionsService.revoke — the RPC's row count is the answer, not decoration.
//
// `revoke_my_session` (mig 0213) is `delete from auth.sessions where id = $1
// and user_id = auth.uid()` + `returns integer` row_count, and its pgTAP
// (supabase/tests/0213_user_sessions_management.test.sql:36-44) pins 0 for
// another user's session and 1 for your own. The service used to discard
// `data`, so a stale second tab, a double click, or any hand-crafted uuid
// produced ok() plus a `security.session_revoked` audit row and a
// force-logout broadcast for a session that was never revoked.
import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { SessionsService } from './sessions';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

function svcWith(result: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({ 'rpc:revoke_my_session': result as never });
  return { svc: new SessionsService(makeServiceContext(stub.client)), stub };
}

describe('SessionsService.revoke', () => {
  it('rejects with not_found when the RPC deleted 0 rows (stale list / foreign id)', async () => {
    const { svc, stub } = svcWith({ data: 0, error: null });
    await expect(svc.revoke(SESSION_ID)).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.rpcCalls).toEqual([
      { name: 'revoke_my_session', args: { p_session_id: SESSION_ID } },
    ]);
  });

  it('resolves when the RPC deleted the caller’s own session (1 row)', async () => {
    const { svc } = svcWith({ data: 1, error: null });
    await expect(svc.revoke(SESSION_ID)).resolves.toBeUndefined();
  });

  it('maps an RPC error to internal_error (raw text kept server-side only)', async () => {
    const { svc } = svcWith({ data: null, error: { message: 'boom' } });
    // ServiceError genericises an internal_error's public `message` and parks
    // the raw DB text on `internalDetail` (context.ts, S13) — assert both so a
    // regression that leaks the DB string into `message` fails here.
    await expect(svc.revoke(SESSION_ID)).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: 'boom',
    });
  });

  it('stays permissive when the RPC reports no count at all', async () => {
    // Deliberate: only a NUMERIC 0 proves nothing was deleted. If the transport
    // ever hands back a non-numeric payload for this scalar RPC we must not
    // invent a user-facing "already signed out" failure for a delete that may
    // well have happened — see the WHY comment on revoke().
    const { svc } = svcWith({ data: null, error: null });
    await expect(svc.revoke(SESSION_ID)).resolves.toBeUndefined();
  });
});
