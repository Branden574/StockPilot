import 'server-only';

import { parseUserAgent } from '@/lib/auth/user-agent';

import { ServiceError, withContext, type ServiceContext } from './context';

export interface SessionInfo {
  id: string;
  label: string;
  /** User-set custom name for this device, or null if none. Shown in place of
   *  `label`; `label` stays available as the auto-detected subtext. */
  customName: string | null;
  ip: string | null;
  lastActiveAt: string | null;
  createdAt: string | null;
  isMfa: boolean;
  isCurrent: boolean;
}

interface SessionRow {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string | null;
  refreshed_at: string | null;
  aal: string | null;
  not_after: string | null;
  custom_name: string | null;
}

export class SessionsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<SessionsService> {
    return new SessionsService(await withContext());
  }

  async list(currentSessionId: string | null): Promise<SessionInfo[]> {
    const { data, error } = await this.ctx.supabase.rpc('list_my_sessions');
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      label: parseUserAgent(r.user_agent).label,
      customName: r.custom_name,
      ip: r.ip,
      lastActiveAt: r.refreshed_at ?? r.created_at,
      createdAt: r.created_at,
      isMfa: r.aal === 'aal2',
      isCurrent: !!currentSessionId && r.id === currentSessionId,
    }));
  }

  /**
   * Set or clear the caller's custom name for one of their OWN sessions. A blank
   * name clears it (reverts to the auto-detected label). The DB function
   * (`set_my_session_name`) enforces ownership via auth.uid() and caps the name
   * at 60 chars, so a name for another user's session id is a silent no-op.
   */
  async rename(sessionId: string, name: string): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('set_my_session_name', {
      p_session_id: sessionId,
      p_name: name,
    });
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /**
   * Sign out ONE of the caller's own devices.
   *
   * `revoke_my_session` (mig 0213) is `delete from auth.sessions where id = $1
   * and user_id = auth.uid()` and `returns integer` row_count precisely so the
   * caller can tell "deleted" from "matched nothing" — its pgTAP pins 0 for
   * another user's session and 1 for your own
   * (supabase/tests/0213_user_sessions_management.test.sql:36-44).
   *
   * We used to discard that count and only check `error`, which is the
   * fail-open-on-0-rows class (recurring pattern #2): a stale second tab, a
   * double click, or any hand-crafted uuid returned ok() — and the action then
   * wrote a `security.session_revoked` audit row and broadcast a force-logout
   * for a session that was never revoked, quietly polluting the forensic trail.
   * A numeric 0 now surfaces as not_found so the UI says so and the audit trail
   * only records revocations that actually happened.
   *
   * Only a NUMERIC 0 is treated as "nothing was deleted". If the transport ever
   * hands back a non-numeric payload for this scalar RPC (a signature change to
   * `returns void`, say), we keep the old permissive behaviour rather than
   * invent a user-facing "already signed out" error for a delete that most
   * likely DID happen — an unreadable count must not break device sign-out.
   *
   * Sibling note: revokeOthers deliberately has no such check — 0 rows there is
   * the legitimate "you have no other devices" answer.
   */
  async revoke(sessionId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase.rpc('revoke_my_session', {
      p_session_id: sessionId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    if (typeof data === 'number' && data === 0) {
      throw new ServiceError('not_found', 'That device is already signed out.');
    }
  }

  async revokeOthers(keepSessionId: string): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('revoke_my_other_sessions', {
      p_keep_session_id: keepSessionId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
