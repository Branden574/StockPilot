import 'server-only';

import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';
import { ownAddressVerdict } from '@/server/lib/current-member';

type AdminClient = ReturnType<typeof createAdminClient>;

/** The order columns that say who requested it. */
export interface RequesterColumns {
  /** The order's organization: a member's own address is used only while
   *  they are a current member of it (docket S36). */
  organization_id: string;
  requester_user_id: string | null;
  requester_name: string | null;
  requester_email: string | null;
  requester_deleted_at?: string | null;
}

/** Who to email for an order's requester (resolveRequesterContact). */
export interface RequesterContact {
  /** The address to email, or null: none, a deleted account, or withheld. */
  email: string | null;
  name: string | null;
  /**
   * Docket S36: the requester's own (profile) address when it was withheld
   * because they are not a current member of the order's organization, or
   * that could not be checked; else null. Never emailed. The sign route
   * compares the signer's address with it: the sign page offers the
   * requester's own address as the default signer email, and a receipt to it
   * would carry the order all the same (the A3 rule for a kept address).
   */
  withheldEmail: string | null;
}

/**
 * Resolve WHO to email for an order's requester, for both hand-over paths:
 * the sign route (a digital signature) and the paper path
 * (OrderRequestsService.confirmPhysicalSignature). Every requester email of
 * those paths goes to the address resolved here: the three hand-over emails
 * (order-handover-notify.ts) and the sign route's completion receipt.
 *
 * SP-020: `OrderRequestsService.create()` fills `requester_name` /
 * `requester_email` ONLY for on-behalf-of (external) orders. A member who
 * submits their own order gets `requester_user_id` set and BOTH name/email
 * columns NULL, so reading the columns directly drops every internal
 * requester out of the recipient set (the sign route did, until SP-020; the
 * paper path did, until L94). Their address is their `user_profiles` row.
 *
 * Docket S36: the rule keys on WHERE THE ADDRESS COMES FROM.
 *   - An address the order recorded (requester_email set) is an outside
 *     person's: an on-behalf-of order (create() then leaves
 *     requester_user_id NULL, 0413:1171-1173), the public request link (NULL
 *     too), a portal order (requester_user_id is the buyer's sign-in, never a
 *     member), or a replacement whose requester had left (0396 copies their
 *     address and leaves the id NULL). It is sent as before, whoever placed
 *     the order.
 *   - A member's own address (their profile's) is used only while they are a
 *     current member of the order's organization (readCurrentMember: accepted,
 *     not an Act-as seat, not disabled; the rule of 0422 and
 *     createNotification). Removing a member or leaving deletes only the
 *     membership row, and the order keeps their id. A read that fails
 *     withholds it too, reported under `report.tag`.
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
  report: { tag: string; orderId: string },
): Promise<RequesterContact> {
  if (order.requester_deleted_at) return { email: null, name: null, withheldEmail: null };
  if (order.requester_email) {
    return {
      email: order.requester_email,
      name: order.requester_name ?? null,
      withheldEmail: null,
    };
  }
  if (!order.requester_user_id) return { email: null, name: null, withheldEmail: null };
  const [verdict, profile] = await Promise.all([
    ownAddressVerdict(
      admin,
      { organizationId: order.organization_id, userId: order.requester_user_id },
      { tag: report.tag, extra: { orderId: report.orderId } },
    ),
    readOwnProfile(admin, order.requester_user_id),
  ]);
  const address = profile?.email ?? null;
  const name = profile?.full_name ?? order.requester_name ?? null;
  if (verdict !== 'current') return { email: null, name, withheldEmail: address };
  return { email: address, name, withheldEmail: null };
}

/** The requester's own address and name; null when unreadable. */
async function readOwnProfile(
  admin: AdminClient,
  userId: string,
): Promise<{ email?: string | null; full_name?: string | null } | null> {
  try {
    const { data } = await admin
      .from('user_profiles')
      .select('email, full_name')
      .eq('id', userId)
      .maybeSingle();
    return data as { email?: string | null; full_name?: string | null } | null;
  } catch {
    return null;
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
