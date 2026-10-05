import 'server-only';

import {
  effectivePermissions,
  formatOrderNumber,
  RETURNS_COPY,
  staffNewRequestBody,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';
import { resolveReturnToken } from '@/server/lib/order-secrets';
import { sendReturnUpdateEmail, type ReturnUpdateEmailEvent } from '@/server/email/return-update';

import { fetchAllRowsByIds, rawErrorText } from './lib/fetch-by-ids';
import { createNotification } from './notifications';

/**
 * Returns notifications (returns plan 3.6.8, RX-1 rows; grafts G11, C-3).
 *
 * WHO HEARS WHAT
 *   • Staff, "New return request": the effective `returns:manage` holders
 *     (role defaults, then role overrides, then user overrides; the owner
 *     always) who can read the original order's warehouse, minus the actor,
 *     each gated by `push_return_requested` (default on, fail-open). ONLY for
 *     requester-sourced RMAs: a return a staff member creates is their own
 *     work and pings nobody (G11).
 *   • The requester, for a requester-sourced RMA: "We received your return
 *     request", "Your return was approved", "We received your returned item",
 *     "Your return request was declined", "Your return request was
 *     cancelled". No reason text ever reaches a requester. A counter approval
 *     (the item handed over in person) sends no approval or receipt message.
 *     Member requesters get an in-app notification (push rides the
 *     notifications trigger) gated by their order-status preference
 *     (`email_order_status_changed`, fail-open), linked to their order. Email-
 *     only requesters get one email, never after a recorded public
 *     unsubscribe. B2B portal users get an email (and the portal shows the
 *     request).
 *
 * DEDUPE: callers emit only after an RPC answered `changed: true`; a replay
 * sends nothing. Sending is best-effort after commit and never throws.
 *
 * LINKS (C-3): staff pushes carry the dual link
 * `/dashboard/returns/<rma>?order=/dashboard/orders/<original>`. The web and
 * new phone bundles open the RMA; an older phone bundle matches its first
 * rewrite rule (the unanchored orders path inside the query) and opens the
 * original order, so no push ever lands on Home.
 */

const NOTIFY_CONCURRENCY = 6;

/** The staff link (see LINKS above). */
export function returnStaffLink(returnId: string, orderId: string): string {
  return `/dashboard/returns/${returnId}?order=/dashboard/orders/${orderId}`;
}

type Admin = ReturnType<typeof createAdminClient>;

/** `notification_preferences.<key>` per user, fail-open (0265 pattern). */
async function prefFlags(admin: Admin, userIds: string[], key: string): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>(userIds.map((id) => [id, true]));
  if (userIds.length === 0) return flags;
  try {
    const rows = await fetchAllRowsByIds<Record<string, unknown>>(
      userIds,
      (batch) => (from, to) =>
        admin
          .from('notification_preferences')
          .select(`user_id, ${key}`)
          .in('user_id', batch)
          .order('user_id')
          .range(from, to) as unknown as PromiseLike<{
          data: Array<Record<string, unknown>> | null;
          error: { message: string } | null;
        }>,
    );
    for (const row of rows) if (row[key] === false) flags.set(row.user_id as string, false);
  } catch (err) {
    void reportError(new Error(rawErrorText(err)), { tag: 'returns_notify.load_prefs', extra: { key } });
  }
  return flags;
}

/**
 * The staff audience for a new requester return: effective returns:manage,
 * read access to the order's warehouse, actor excluded, preference honoured.
 * Never throws; a resolution failure is reported and resolves to [].
 */
export async function resolveReturnStaffAudience(args: {
  organizationId: string;
  warehouseId: string | null;
  actorUserId: string | null;
}): Promise<string[]> {
  const { organizationId, warehouseId, actorUserId } = args;
  try {
    const admin = createAdminClient();
    const [membersRes, roleOvRes, userOvRes, assignRes] = await Promise.all([
      admin
        .from('organization_members')
        .select('user_id, role')
        .eq('organization_id', organizationId)
        .not('accepted_at', 'is', null),
      admin
        .from('role_permission_overrides')
        .select('role, permission, granted')
        .eq('organization_id', organizationId)
        .eq('permission', 'returns:manage'),
      admin
        .from('user_permission_overrides')
        .select('user_id, permission, granted')
        .eq('organization_id', organizationId)
        .eq('permission', 'returns:manage'),
      warehouseId
        ? admin
            .from('user_warehouse_assignments')
            .select('user_id, warehouse_id')
            .eq('organization_id', organizationId)
            .eq('warehouse_id', warehouseId)
        : Promise.resolve({ data: [] as Array<{ user_id: string; warehouse_id: string }>, error: null }),
    ]);
    if (membersRes.error) throw new Error(membersRes.error.message);
    if (roleOvRes.error) throw new Error(roleOvRes.error.message);
    if (userOvRes.error) throw new Error(userOvRes.error.message);
    if (assignRes.error) throw new Error(assignRes.error.message);

    const members = (membersRes.data ?? []) as Array<{ user_id: string; role: Role }>;
    const roleOv = (roleOvRes.data ?? []) as Array<PermissionOverride & { role: Role }>;
    const userOv = (userOvRes.data ?? []) as Array<PermissionOverride & { user_id: string }>;
    const assigned = new Set(
      ((assignRes.data ?? []) as Array<{ user_id: string; warehouse_id: string }>)
        .filter((a) => a.warehouse_id === warehouseId)
        .map((a) => a.user_id),
    );

    const eligible: string[] = [];
    for (const m of members) {
      if (actorUserId && m.user_id === actorUserId) continue;
      const effective = effectivePermissions(
        m.role,
        roleOv.filter((o) => o.role === m.role).map(({ permission, granted }) => ({ permission, granted })),
        userOv.filter((o) => o.user_id === m.user_id).map(({ permission, granted }) => ({ permission, granted })),
      );
      if (!effective.has('returns:manage')) continue;
      const seesEvery = m.role === 'owner' || m.role === 'admin' || m.role === 'manager';
      if (!seesEvery && !assigned.has(m.user_id)) continue;
      eligible.push(m.user_id);
    }
    if (eligible.length === 0) return [];
    const flags = await prefFlags(admin, eligible, 'push_return_requested');
    return eligible.filter((id) => flags.get(id) !== false);
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'returns_notify.resolve_audience',
      extra: { organizationId },
    });
    return [];
  }
}

export interface ReturnNotifyRma {
  organizationId: string;
  returnId: string;
  returnNumber: string | null;
  orderId: string;
}

/** "New return request" to the staff audience. Requester-sourced RMAs only. */
export async function notifyStaffNewReturnRequest(
  rma: ReturnNotifyRma & { actorUserId: string | null; kind?: 'return' | 'exchange' },
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: order, error } = await admin
      .from('order_requests')
      .select('id, warehouse_id, order_number, requester_name, requester_email')
      .eq('id', rma.orderId)
      .eq('organization_id', rma.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return;
    const o = order as {
      warehouse_id: string | null;
      order_number: number | null;
      requester_name: string | null;
      requester_email: string | null;
    };
    const recipients = await resolveReturnStaffAudience({
      organizationId: rma.organizationId,
      warehouseId: o.warehouse_id,
      actorUserId: rma.actorUserId,
    });
    if (recipients.length === 0) return;
    const title = rma.kind === 'exchange' ? RETURNS_COPY.staffNewExchangeTitle : RETURNS_COPY.staffNewReturnTitle;
    const body = staffNewRequestBody(o.requester_name ?? o.requester_email, rma.returnNumber, o.order_number);
    await mapWithConcurrency(recipients, NOTIFY_CONCURRENCY, (userId) =>
      createNotification({
        organizationId: rma.organizationId,
        userId,
        type: 'return.requested',
        title,
        body,
        link: returnStaffLink(rma.returnId, rma.orderId),
        metadata: { return_id: rma.returnId, order_request_id: rma.orderId, return_number: rma.returnNumber },
      }),
    );
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'returns_notify.staff_new_request',
      extra: { organizationId: rma.organizationId, returnId: rma.returnId },
    });
  }
}

export type RequesterReturnEvent = ReturnUpdateEmailEvent;

const REQUESTER_TITLES: Record<RequesterReturnEvent, string> = {
  request_received: RETURNS_COPY.requesterReceivedReturnRequest,
  approved: RETURNS_COPY.requesterReturnApproved,
  received: RETURNS_COPY.requesterItemReceived,
  denied: RETURNS_COPY.requesterReturnDeclined,
  cancelled: RETURNS_COPY.requesterReturnCancelled,
};

/** Whether this event reaches the requester at all, given how it happened. */
export function requesterHearsEvent(event: RequesterReturnEvent, input: { source: string; channel?: string | null }): boolean {
  if (input.source !== 'requester') return false;
  // A counter approval or receipt happened with the requester standing there.
  if ((event === 'approved' || event === 'received') && input.channel === 'counter') return false;
  return true;
}

/**
 * One requester message for a requester-sourced RMA (see the module header).
 * Never throws.
 */
export async function notifyRequesterReturnEvent(
  rma: ReturnNotifyRma & { event: RequesterReturnEvent; source: string; channel?: string | null },
): Promise<void> {
  if (!requesterHearsEvent(rma.event, rma)) return;
  try {
    const admin = createAdminClient();
    const { data: order, error } = await admin
      .from('order_requests')
      .select('id, source, customer_id, requester_user_id, requester_email, requester_name, order_number')
      .eq('id', rma.orderId)
      .eq('organization_id', rma.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return;
    const o = order as {
      source: string;
      customer_id: string | null;
      requester_user_id: string | null;
      requester_email: string | null;
      requester_name: string | null;
      order_number: number | null;
    };
    const title = REQUESTER_TITLES[rma.event];
    const handle = rma.returnNumber ?? formatOrderNumber(o.order_number) ?? 'your order';
    const isPortal = o.source === 'portal';

    // An account holder hears in the app. A B2B portal user is not a member;
    // the portal itself lists the request, so they hear by email instead.
    if (o.requester_user_id && !isPortal) {
      const flags = await prefFlags(admin, [o.requester_user_id], 'email_order_status_changed');
      if (flags.get(o.requester_user_id) !== false) {
        await createNotification({
          organizationId: rma.organizationId,
          userId: o.requester_user_id,
          type: `return.${rma.event}`,
          title,
          body: handle,
          link: `/dashboard/orders/${rma.orderId}`,
          metadata: { return_id: rma.returnId, order_request_id: rma.orderId, return_number: rma.returnNumber },
        });
      }
      return;
    }

    if (!o.requester_email) return;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';
    const token = isPortal ? null : await resolveReturnToken(admin, rma.orderId);
    await sendReturnUpdateEmail(admin, {
      event: rma.event,
      to: o.requester_email,
      recipientName: o.requester_name,
      returnNumber: rma.returnNumber,
      orderNumber: formatOrderNumber(o.order_number),
      isAccountHolder: Boolean(o.requester_user_id),
      viewUrl: isPortal
        ? `${appUrl.replace(/\/+$/, '')}/portal`
        : token
          ? `${appUrl.replace(/\/+$/, '')}/returns/request/${token}`
          : null,
      appUrl,
    });
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'returns_notify.requester_event',
      extra: { organizationId: rma.organizationId, returnId: rma.returnId, event: rma.event },
    });
  }
}
