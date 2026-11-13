import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';
import { readCurrentMember } from '@/server/lib/current-member';

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
 * Writes nothing (returns null) for a disabled account, or for anyone who is
 * not a current member of `organizationId` (removed, left, an invite never
 * accepted, a support Act-as seat), or when either cannot be read (reported).
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
    // path every caller in the codebase funnels through, so one check here
    // closes the gap for all of them rather than requiring each call site
    // to remember it.
    //
    // The recipient must also still be a member of the notice's organization
    // (docket S36): an accepted membership that is not a support Act-as seat,
    // the rule the database's own notices follow (0422,
    // _notify_is_current_member). Several callers address a stored id, such as
    // an order's requester, and removing a member or leaving deletes only the
    // membership row, so the person kept getting pushes about the
    // organization's orders.
    //
    // Both facts come from the one current-member read the app's emails to a
    // member's own address use too (server/lib/current-member.ts), from the
    // tables rather than the 0422 function, so a web deploy never depends on
    // the migration. Both fail CLOSED (docket S36, integrator decision
    // 2026-11-01): a read that fails is reported and nothing is written, so
    // nothing is pushed. The disable check used to fail OPEN, an unreadable
    // profile counting as "not disabled" under this function's best-effort
    // contract. Best-effort delivery makes a notice dropped on a read error
    // acceptable; a push carrying the organization's data to an account
    // disabled for suspected compromise is not.
    const recipient = await readCurrentMember(admin, args.organizationId, args.userId);
    if (!recipient.readable) {
      for (const failure of recipient.failures) {
        void reportError(
          failure.error,
          failure.read === 'profile'
            ? { tag: 'notifications.create_disabled_check', extra: { userId: args.userId } }
            : {
                tag: 'notifications.create_member_check',
                extra: { organizationId: args.organizationId, userId: args.userId },
              },
        );
      }
      return null;
    }
    if (!recipient.current) return null;

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
