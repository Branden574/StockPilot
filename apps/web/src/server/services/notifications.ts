import 'server-only';

import { ServiceError, withContext, type ServiceContext } from './context';

export class NotificationsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new NotificationsService(await withContext());
  }

  async list(params: { onlyUnread?: boolean; limit?: number } = {}) {
    const limit = Math.min(params.limit ?? 50, 200);
    let query = this.ctx.supabase
      .from('notifications')
      .select('id, type, title, body, link, metadata, read_at, created_at')
      .eq('user_id', this.ctx.userId)
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (params.onlyUnread) query = query.is('read_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async unreadCount() {
    const { count, error } = await this.ctx.supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', this.ctx.userId)
      .eq('organization_id', this.ctx.organizationId)
      .is('read_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  async markRead(id: string) {
    const { error } = await this.ctx.supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', this.ctx.userId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async markAllRead() {
    const { error } = await this.ctx.supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', this.ctx.userId)
      .eq('organization_id', this.ctx.organizationId)
      .is('read_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
