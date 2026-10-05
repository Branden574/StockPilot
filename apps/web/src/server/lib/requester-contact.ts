import 'server-only';

import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';

type AdminClient = ReturnType<typeof createAdminClient>;

/** The order columns that say who requested it. */
export interface RequesterColumns {
  requester_user_id: string | null;
  requester_name: string | null;
  requester_email: string | null;
  requester_deleted_at?: string | null;
}

/**
 * Resolve WHO to email for an order's requester, for both hand-over paths:
 * the sign route (a digital signature) and the paper path
 * (OrderRequestsService.confirmPhysicalSignature).
 *
 * SP-020: `OrderRequestsService.create()` fills `requester_name` /
 * `requester_email` ONLY for on-behalf-of (external) orders. A member who
 * submits their own order gets `requester_user_id` set and BOTH name/email
 * columns NULL, so reading the columns directly drops every internal
 * requester out of the recipient set (the sign route did, until SP-020; the
 * paper path did, until L94). Their address is their `user_profiles` row.
 *
 * A requester who deleted their account is never emailed again (A3), not
 * even at the address the order recorded (the copy is kept, O-A3-6).
 *
 * Fails CLOSED-safe: if the profile read errors we return no address, which
 * degrades to the in-app notification only rather than failing a hand-over
 * the database has already recorded.
 */
export async function resolveRequesterContact(
  admin: AdminClient,
  order: RequesterColumns,
): Promise<{ email: string | null; name: string | null }> {
  if (order.requester_deleted_at) return { email: null, name: null };
  if (order.requester_email) {
    return { email: order.requester_email, name: order.requester_name ?? null };
  }
  if (!order.requester_user_id) return { email: null, name: null };
  try {
    const { data } = await admin
      .from('user_profiles')
      .select('email, full_name')
      .eq('id', order.requester_user_id)
      .maybeSingle();
    const profile = data as { email?: string | null; full_name?: string | null } | null;
    return {
      email: profile?.email ?? null,
      name: profile?.full_name ?? order.requester_name ?? null,
    };
  } catch {
    return { email: null, name: order.requester_name ?? null };
  }
}

/**
 * Whether the requester muted order emails
 * (notification_preferences.email_order_completed, 0113), read ONCE per
 * hand-over and honoured by the completion receipt and the backorder notices.
 *
 * Gated on `requester_user_id` alone (SP-020: the population that CAN opt out
 * is internal members, whose email column is always NULL). External
 * requesters (no user row) cannot opt out and always get transactional mail.
 * Read with the service client: the caller's RLS cannot see another member's
 * preferences row.
 *
 * A failed read counts as OPTED OUT (fail closed) and is reported under
 * `tag`: these emails are optional for a member, and mailing someone who
 * muted them is worse than one missed notice.
 */
export async function requesterEmailOptedOut(
  admin: AdminClient,
  requesterUserId: string | null,
  report: { tag: string; orderId: string },
): Promise<boolean> {
  if (!requesterUserId) return false;
  const { data, error } = await admin
    .from('notification_preferences')
    .select('email_order_completed')
    .eq('user_id', requesterUserId)
    .maybeSingle();
  if (error) {
    await reportError(error, {
      tag: report.tag,
      level: 'warning',
      extra: { orderId: report.orderId },
    });
    return true;
  }
  return ((data as { email_order_completed?: boolean } | null)?.email_order_completed ?? true) === false;
}
