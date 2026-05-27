import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';

import { notifyUser } from './push';
import { ServiceError, withContext, type ServiceContext } from './context';

export interface CreateNotificationArgs {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

/**
 * One canonical place to drop a notification into the inbox AND push
 * it to the user's registered devices. Callers (PO approval, order
 * request status changes, low-stock alerts) should funnel through
 * here instead of inserting directly so a push always accompanies
 * the row insert.
 *
 * Returns the inserted row id. Never throws — failures are reported
 * via reportError so the calling write path (e.g. approving a PO)
 * doesn't fail just because the notification side errored.
 */
export async function createNotification(
  args: CreateNotificationArgs,
): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('notifications')
      .insert({
        organization_id: args.organizationId,
        user_id: args.userId,
        type: args.type,
        title: args.title,
        body: args.body ?? null,
        link: args.link ?? null,
        metadata: args.metadata ?? {},
      })
      .select('id')
      .single();
    if (error) {
      void reportError(new Error(error.message), {
        tag: 'notifications.create_insert',
        extra: { userId: args.userId },
      });
      return null;
    }
    // Fan out to the user's devices. notifyUser is fire-and-forget
    // safe; never throws, never blocks the caller meaningfully.
    void notifyUser({
      userId: args.userId,
      title: args.title,
      body: args.body,
      link: args.link,
      data: args.metadata,
    });
    return (data?.id as string | undefined) ?? null;
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'notifications.create_uncaught',
      extra: { userId: args.userId },
    });
    return null;
  }
}

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
