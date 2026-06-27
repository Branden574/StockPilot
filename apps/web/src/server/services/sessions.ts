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

  async revoke(sessionId: string): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('revoke_my_session', {
      p_session_id: sessionId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async revokeOthers(keepSessionId: string): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('revoke_my_other_sessions', {
      p_keep_session_id: keepSessionId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
