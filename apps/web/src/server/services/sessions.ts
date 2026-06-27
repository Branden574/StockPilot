import 'server-only';

import { parseUserAgent } from '@/lib/auth/user-agent';

import { ServiceError, withContext, type ServiceContext } from './context';

export interface SessionInfo {
  id: string;
  label: string;
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
      ip: r.ip,
      lastActiveAt: r.refreshed_at ?? r.created_at,
      createdAt: r.created_at,
      isMfa: r.aal === 'aal2',
      isCurrent: !!currentSessionId && r.id === currentSessionId,
    }));
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
