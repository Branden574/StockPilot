import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { env } from '@/lib/env';
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
    .select('id, organization_id, requester_name, requester_email, fulfillment_type')
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
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: error.message } },
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
          appUrl: env.NEXT_PUBLIC_APP_URL,
        });
      }
    } catch {
      /* email failure is non-fatal; the row is completed */
    }
  }

  return NextResponse.json({ ok: true, data: { id: order.id } }, { status: 200 });
}
