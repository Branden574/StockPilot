import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

// Why a route handler instead of a Server Action: the public sign page
// renders <SignatureCollector /> only while `signed_at IS NULL`. A
// Server Action automatically triggers an RSC re-fetch of the calling
// route after returning — that re-render sees the row is now signed
// and swaps the collector for the "already signed" panel, unmounting
// the client component and obliterating its success state. A regular
// fetch() to this route handler is silent on the page tree, so the
// client component keeps showing its "Thank you" panel.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'validation_error', message: 'Invalid request body' } },
      { status: 400 },
    );
  }

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
        },
      },
      { status: 400 },
    );
  }

  // Rate-limit per token. Closed mode: a DB outage denies rather than
  // unlocks unlimited submissions on a public endpoint.
  const rl = await checkRateLimit(
    `order-sign:${parsed.data.token}`,
    10,
    60 * 60 * 1000,
    'closed',
  );
  if (!rl.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'rate_limited',
          message: 'Too many attempts. Try again in a few minutes.',
        },
      },
      { status: 429 },
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Server is missing SUPABASE_SERVICE_ROLE_KEY. Try again in a few minutes.',
        },
      },
      { status: 500 },
    );
  }

  const { data: row } = await admin
    .from('order_requests')
    .select(
      'id, organization_id, requester_user_id, requester_name, requester_email, fulfillment_type',
    )
    .eq('signature_token', parsed.data.token)
    .maybeSingle();
  if (!row) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'not_found', message: 'This signature link is invalid or expired.' },
      },
      { status: 404 },
    );
  }
  const order = row as {
    id: string;
    organization_id: string;
    requester_user_id: string | null;
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
  if (error) {
    await reportError(error, {
      tag: 'orders.sign.rpc',
      extra: { orderId: order.id },
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Signature could not be recorded. Please try again.',
        },
      },
      { status: 500 },
    );
  }
  if (!confirmed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This order is already signed, expired, or cannot be signed.',
        },
      },
      { status: 409 },
    );
  }

  // Live tracking: the order just left in_transit (now completed) — purge the
  // driver's live GPS point so no location lingers after delivery (best-effort).
  try {
    await admin.from('delivery_locations').delete().eq('order_request_id', order.id);
  } catch {
    /* non-fatal */
  }

  // Returns Phase B (B4): the order just became 'completed' and is therefore
  // RETURNABLE. If the org has the off-by-default `returns` module enabled,
  // mint a per-order return_token (0156) so the requester can be emailed a
  // self-service return link (/returns/request/<token>). Best-effort and
  // idempotent — we only set the token when it's still NULL, so a replayed
  // sign (already guarded against double-completion by the RPC) never rotates
  // an issued token. A failure here must NOT fail the signature.
  try {
    const { data: modRow } = await admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', order.organization_id)
      .eq('module_id', 'returns')
      .eq('enabled', true)
      .maybeSingle();
    if (modRow) {
      const newToken = crypto.randomUUID();
      // Only stamp + email when the token was still NULL — the .select()
      // returns zero rows on a replay (token already set), so a repeated
      // sign never re-sends the return link.
      const { data: tokened } = await admin
        .from('order_requests')
        .update({ return_token: newToken })
        .eq('id', order.id)
        .is('return_token', null)
        .select('id')
        .maybeSingle();
      if (tokened && order.requester_email) {
        await sendReturnLinkEmail({
          to: order.requester_email,
          recipientName: order.requester_name,
          appUrl: env.NEXT_PUBLIC_APP_URL,
          token: newToken,
        });
      }
    }
  } catch {
    /* non-fatal — the order is completed regardless of token issuance */
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
      // Respect notification_preferences.email_order_completed for the
      // internal requester (column added in 0113). External public-link
      // requesters and the physical signer always get the email —
      // there's no profile row to opt out of, and the signer needs a
      // transactional receipt of the signature they just submitted.
      let requesterOptedOut = false;
      if (order.requester_user_id && order.requester_email) {
        const { data: prefRow } = await admin
          .from('notification_preferences')
          .select('email_order_completed')
          .eq('user_id', order.requester_user_id)
          .maybeSingle();
        // Default true (matches table default) when the row is missing.
        const wantsEmail =
          (prefRow as { email_order_completed?: boolean } | null)
            ?.email_order_completed ?? true;
        requesterOptedOut = !wantsEmail;
      }

      const recipients = new Set<string>();
      if (order.requester_email && !requesterOptedOut) {
        recipients.add(order.requester_email);
      }
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
          appUrl: env.NEXT_PUBLIC_APP_URL,
        });
      }
    } catch {
      /* email failure is non-fatal; the row is completed */
    }
  }

  return NextResponse.json({ ok: true, data: { id: order.id } }, { status: 200 });
}

/**
 * Lightweight return-link email (Returns Phase B, B4). Sent once, when a
 * completed order first gets a return_token issued, to the order's requester.
 * Deliberately uses the bare `sendEmail` (not the heavier order-request
 * templates) so the return portal can ship without coupling to in-flight
 * template work. Best-effort: the caller wraps it so a send failure never
 * fails the signature.
 */
async function sendReturnLinkEmail(args: {
  to: string;
  recipientName: string | null;
  appUrl: string;
  token: string;
}): Promise<void> {
  const firstName = args.recipientName?.split(' ')[0] ?? 'there';
  const base = args.appUrl.replace(/\/+$/, '');
  const url = `${base}/returns/request/${args.token}`;
  const safeName = escapeHtml(firstName);
  const safeUrl = escapeHtml(url);
  await sendEmail({
    to: args.to,
    subject: 'Need to return anything from your order?',
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#111">` +
      `<p>Hi ${safeName},</p>` +
      `<p>Your order is complete. If you need to send anything back, you can start a return request below — the warehouse team will review it.</p>` +
      `<p><a href="${safeUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Request a return</a></p>` +
      `<p style="color:#666;font-size:12px">Or paste this link into your browser:<br>${safeUrl}</p>` +
      `</div>`,
    text:
      `Hi ${firstName},\n\nYour order is complete. If you need to send anything back, ` +
      `start a return request here:\n${url}\n\nThe warehouse team will review it.`,
  });
}

/** Minimal HTML escaping for the few interpolated values above. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
