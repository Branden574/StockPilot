import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';

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
 * One canonical place to drop a notification into the inbox. Push fan-out
 * happens in the DATABASE: the AFTER INSERT trigger on public.notifications
 * (trg_notifications_dispatch_push, mig 0028) posts to Expo via pg_net for
 * every insert — the same single push path the SQL RPC writers (order
 * status, low stock, PO received, …) already rely on. NEVER send push from
 * here on top of the insert: a notifyUser() call here double-pushed every
 * notification created through this function (owner's duplicate lock-screen
 * banners, diagnosed 2026-07-14 — 1 row + 1 token, yet 2 banners: one from
 * this code path, one from the trigger).
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

    // The account-disable program (migs 0308-0311) blocks READS via RLS,
    // but this insert runs as service-role and the 0028 AFTER-INSERT
    // trigger fans out to push unconditionally — so a user disabled for
    // suspected compromise kept getting lock-screen push banners carrying
    // PO numbers, low-stock SKUs and deep links. This is the ONE insert
    // path every caller in the codebase funnels through, so one point-read
    // here closes the gap for all of them rather than requiring each call
    // site to remember it. A failed read is treated as "unknown, not
    // disabled" (fail OPEN): this function's contract is best-effort
    // delivery that never throws, and an unreadable profile is a read
    // error, not evidence of a disable.
    const { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('disabled_at')
      .eq('id', args.userId)
      .maybeSingle();
    if (profileError) {
      void reportError(new Error(profileError.message), {
        tag: 'notifications.create_disabled_check',
        extra: { userId: args.userId },
      });
    }
    if ((profile as { disabled_at: string | null } | null)?.disabled_at) {
      return null;
    }

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
    // Push is dispatched by the notifications AFTER INSERT trigger (see the
    // function doc) — deliberately NO notifyUser() call here.
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
