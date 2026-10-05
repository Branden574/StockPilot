import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { assertEmailWeight } from '@/lib/email/es/components';
import {
  FULFILLMENT_ORDERS_FROM,
  buildPrefEmailDelivery,
  renderReturnUpdateEmail,
  type ReturnUpdateEvent,
} from '@/lib/email/es/families/fulfillment';
import { sendEmail } from '@/lib/email/resend';
import { normalizeUnsubscribeEmail } from '@/lib/email/unsubscribe';
import { reportError } from '@/lib/error-reporter';

/**
 * The requester's return update email (returns RX-1, plan 3.6.8): one email
 * per event for an email-only or B2B portal requester of a requester-sourced
 * RMA. The caller emits it only after the RPC answered `changed: true`, so a
 * replay never sends twice; a crash between commit and send loses that one
 * email (best-effort, never a duplicate).
 *
 * A PUBLIC (account-less) requester who recorded a one-click opt-out
 * (public_email_unsubscribes, 0222) gets nothing; an unreadable list counts
 * as opted out (the return prompt's fail-closed posture). Account holders
 * manage this through their notification settings, and the footer links
 * there. Never throws.
 */
export type ReturnUpdateEmailEvent = ReturnUpdateEvent;

export type ReturnUpdateEmailResult =
  | { sent: true }
  | { sent: false; reason: 'suppressed' | 'send_failed' };

export async function sendReturnUpdateEmail(
  admin: SupabaseClient,
  args: {
    event: ReturnUpdateEvent;
    to: string;
    recipientName: string | null;
    returnNumber: string | null;
    orderNumber: string | null;
    isAccountHolder: boolean;
    viewUrl: string | null;
    appUrl: string;
  },
): Promise<ReturnUpdateEmailResult> {
  try {
    if (!args.isAccountHolder && (await isPublicAddressUnsubscribed(admin, args.to))) {
      return { sent: false, reason: 'suppressed' };
    }
    const base = args.appUrl.replace(/\/+$/, '');
    const delivery = buildPrefEmailDelivery({
      appUrl: base,
      recipientEmail: args.to,
      isAccountHolder: args.isAccountHolder,
    });
    const rendered = renderReturnUpdateEmail({
      event: args.event,
      returnNumber: args.returnNumber,
      orderNumber: args.orderNumber,
      recipientFirstName: args.recipientName,
      recipientEmail: args.to,
      viewUrl: args.viewUrl,
      urls: delivery.urls,
    });
    assertEmailWeight(rendered.html);
    await sendEmail({
      to: args.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: FULFILLMENT_ORDERS_FROM,
      headers: delivery.headers,
    });
    return { sent: true };
  } catch (e) {
    try {
      await reportError(e, { tag: 'returns.update_email.send', extra: { event: args.event } });
    } catch {
      /* reporting is itself best-effort */
    }
    return { sent: false, reason: 'send_failed' };
  }
}

async function isPublicAddressUnsubscribed(admin: SupabaseClient, email: string): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from('public_email_unsubscribes')
      .select('email')
      .eq('email', normalizeUnsubscribeEmail(email))
      .maybeSingle();
    if (error) return true;
    return data != null;
  } catch {
    return true;
  }
}
