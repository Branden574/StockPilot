'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { env } from '@/lib/env';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Public signature submission for `/orders/sign/<token>`.
 *
 * The page has NO Supabase JWT — the URL token IS the auth. We:
 *   1. Validate the token shape + signer details with zod.
 *   2. Rate-limit per token (10/hr, closed-mode — a DB outage denies
 *      rather than unlocks). The bucket key is the token itself so a
 *      single bad link can't burn rate budget on a different order.
 *   3. Look up the order via the service-role admin client so we can
 *      bypass RLS.
 *   4. Call the `confirm_order_signature` RPC (migration 0112) — that
 *      RPC's WHERE clause owns the replay-protection (signed_at IS
 *      NULL), expiry check, and status gate atomically. Returns the
 *      org id on success, null on any failure.
 *   5. On success, send a completion email to BOTH the original
 *      requester (if any) AND the signer (in case the signer is a
 *      different person — common when a school secretary signs for a
 *      teacher's order). Email failure is non-fatal.
 *
 * Ambiguous-failure UI is enforced at the page level — this action
 * still returns specific error codes for client toasts.
 */

const TOKEN_RE = /^[0-9a-f]{64}$/i;
const DATA_URL_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

const submitSchema = z.object({
  token: z.string().regex(TOKEN_RE),
  signerName: z.string().trim().min(1).max(120),
  signerEmail: z.string().trim().email().max(254),
  signatureDataUrl: z
    .string()
    .min(64)
    .max(500_000)
    .regex(DATA_URL_RE, 'Invalid signature image'),
});

export async function submitOrderSignatureAction(
  input: z.input<typeof submitSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Rate-limit per token. Closed mode: a DB outage denies the request
  // rather than unlocking unlimited submissions on a public endpoint.
  const rl = await checkRateLimit(
    `order-sign:${parsed.data.token}`,
    10,
    60 * 60 * 1000,
    'closed',
  );
  if (!rl.allowed) {
    return err('rate_limited', 'Too many attempts. Try again in a few minutes.');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err(
      'internal_error',
      'Server is missing SUPABASE_SERVICE_ROLE_KEY. Try again in a few minutes.',
    );
  }

  const { data: row } = await admin
    .from('order_requests')
    .select('id, organization_id, requester_name, requester_email, fulfillment_type')
    .eq('signature_token', parsed.data.token)
    .maybeSingle();
  if (!row) {
    return err('not_found', 'This signature link is invalid or expired.');
  }
  const order = row as {
    id: string;
    organization_id: string;
    requester_name: string | null;
    requester_email: string | null;
    fulfillment_type: 'pickup' | 'delivery';
  };

  const { data: confirmed, error } = await admin.rpc('confirm_order_signature', {
    p_id: order.id,
    p_signature_token: parsed.data.token,
    p_signer_name: parsed.data.signerName,
    p_signer_email: parsed.data.signerEmail,
    p_signature_data_url: parsed.data.signatureDataUrl,
  });
  if (error) return err('internal_error', error.message);
  if (!confirmed) {
    return err('not_found', 'This order is already signed, expired, or cannot be signed.');
  }

  // Fetch the full row for the completion email payload. Done AFTER
  // the RPC succeeds so the email reflects the final completed state.
  const { data: fullRow } = await admin
    .from('order_requests')
    .select('*')
    .eq('id', order.id)
    .single();
  if (fullRow) {
    try {
      const recipients = new Set<string>();
      if (order.requester_email) recipients.add(order.requester_email);
      recipients.add(parsed.data.signerEmail);
      for (const recipient of recipients) {
        await sendOrderRequestEmail({
          kind: 'completed',
          request: fullRow as Parameters<typeof sendOrderRequestEmail>[0]['request'],
          recipientEmail: recipient,
          recipientName:
            recipient === order.requester_email
              ? order.requester_name
              : parsed.data.signerName,
          appUrl: env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
        });
      }
    } catch {
      /* email failure is non-fatal; the row is completed */
    }
  }

  revalidatePath(`/dashboard/orders/${order.id}`);
  return ok({ id: order.id });
}
