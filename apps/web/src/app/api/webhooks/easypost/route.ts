import crypto from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { getConnectionSecret } from '@/server/connectors/secret-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * EasyPost tracking webhook. ONE-WAY by design: EasyPost pushes tracking
 * `Event`s (mostly `tracker.updated`) and we update the matching
 * `carrier_shipments` row's tracking status — we NEVER mutate StockPilot
 * inventory from EasyPost.
 *
 * SECURITY:
 *  - The webhook is HMAC-signature-gated. EasyPost signs the raw request body
 *    with the per-connection webhook secret (stored ONLY in Vault) and sends the
 *    digest in the `X-Hmac-Signature` header. We recompute HMAC-SHA256 over the
 *    RAW body and timing-safe-compare. The secret is NEVER logged or returned.
 *  - The shipment id / tracking_code in the payload is UNTRUSTED until the
 *    signature verifies. We look up the local row by `easypost_shipment_id` (or
 *    `tracking_code`) BEFORE verifying so we can resolve which connection's
 *    secret to verify against, but we do NOT mutate anything until the signature
 *    passes.
 *  - No matching shipment -> 200 no-op (so EasyPost stops retrying a stray
 *    event). Invalid signature -> 401.
 *
 * IDEMPOTENT: the update is a last-write on the single matched row. Re-delivery
 * of the same (or a stale) event simply rewrites the same fields.
 */

/** The `X-Hmac-Signature` header EasyPost sends when a webhook secret is set. */
const SIGNATURE_HEADER = 'X-Hmac-Signature';

/** A `carrier_shipments` status we drive from the tracker status. */
type ShipmentStatus = 'in_transit' | 'delivered' | 'returned' | 'failure';

/**
 * Map an EasyPost tracker `status` onto our `carrier_shipments.status`.
 * EasyPost tracker statuses: `unknown`, `pre_transit`, `in_transit`,
 * `out_for_delivery`, `delivered`, `available_for_pickup`, `return_to_sender`,
 * `failure`, `cancelled`, `error`. We collapse them onto the lifecycle states
 * the table's CHECK constraint allows. `null` means "leave `status` unchanged"
 * (e.g. `unknown`/`pre_transit` — we still record `tracking_status` verbatim).
 */
function mapTrackingStatus(trackingStatus: string): ShipmentStatus | null {
  switch (trackingStatus) {
    case 'in_transit':
    case 'out_for_delivery':
    case 'available_for_pickup':
      return 'in_transit';
    case 'delivered':
      return 'delivered';
    case 'return_to_sender':
      return 'returned';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      // unknown / pre_transit / cancelled / anything new: don't force a
      // lifecycle transition, but the raw tracking_status is still persisted.
      return null;
  }
}

/**
 * Timing-safe compare of the signature header against an HMAC-SHA256 of the raw
 * body keyed by the connection's webhook secret. EasyPost sends the digest as
 * `hmac-sha256-hex=<hex>`; we accept that prefixed form and a bare hex digest.
 * Returns false (never throws) on any malformed input so a bad header is a clean
 * 401 rather than a 500.
 *
 * NFKD: EasyPost computes its HMAC over the NFKD (compatibility-decomposed)
 * Unicode normalization of the webhook secret, so a secret containing any
 * non-ASCII characters (or precomposed code points) only verifies if we key our
 * HMAC with the SAME NFKD form. We normalize before keying to match EasyPost.
 * For a pure-ASCII secret NFKD is a no-op (ASCII is already in normal form), so
 * this is invisible to existing ASCII secrets and only fixes Unicode ones.
 */
function verifySignature(rawBody: string, secret: string, header: string | null): boolean {
  if (!header || !secret) return false;
  // Strip an optional `hmac-sha256-hex=` (or similar `algo=`) prefix.
  const provided = header.includes('=') ? header.slice(header.indexOf('=') + 1) : header;
  const normalizedSecret = secret.normalize('NFKD');
  const expected = crypto
    .createHmac('sha256', Buffer.from(normalizedSecret, 'utf8'))
    .update(Buffer.from(rawBody, 'utf8'))
    .digest('hex');
  // timingSafeEqual requires equal-length buffers — a length mismatch is itself
  // a non-match, so guard before comparing to avoid the throw.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

interface MatchableShipment {
  id: string;
  organization_id: string;
  connection_id: string | null;
}

export async function POST(req: NextRequest) {
  // Rate-limit by IP BEFORE any DB access. The shipment/tracking lookups below
  // run PRE-signature (we must resolve which connection's secret to verify
  // against), so without this an unauthenticated flood drives 1-2 admin queries
  // per request unbounded — connection-pool DoS + an existence oracle. Closed
  // mode: a limiter outage denies rather than opening the floodgate.
  const ip = clientIpFromRequest(req);
  const rl = await checkRateLimit(`easypost-webhook:${ip}`, 120, 60_000, 'closed');
  if (!rl.allowed) {
    return new NextResponse('Too Many Requests', { status: 429 });
  }

  // Read the RAW body once: HMAC must be computed over the exact bytes EasyPost
  // signed, so we cannot use req.json() (which would re-serialize differently).
  const rawBody = await req.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Not JSON we can act on. Nothing to update -> no-op (200) so EasyPost
    // doesn't retry a malformed delivery forever. We never reached secrets.
    return NextResponse.json({ received: true, ignored: 'unparseable' });
  }

  // EasyPost Event envelope: `{ result: <Tracker>, description: 'tracker.updated', ... }`.
  // Be liberal: the tracker may also arrive at the top level. All of this is
  // UNTRUSTED until the signature verifies.
  const result = (payload.result as Record<string, unknown> | undefined) ?? payload;
  const easypostShipmentId =
    typeof result.shipment_id === 'string' ? result.shipment_id : null;
  const trackingCode =
    typeof result.tracking_code === 'string' ? result.tracking_code : null;
  const trackingStatusRaw = typeof result.status === 'string' ? result.status : null;
  const trackingUrl = typeof result.public_url === 'string' ? result.public_url : null;

  if (!easypostShipmentId && !trackingCode) {
    // No key to find a local row by -> nothing to do. No-op.
    return NextResponse.json({ received: true, ignored: 'no_identifier' });
  }

  const admin = createAdminClient();

  // Find the matched row via the service-role client (the webhook has no user
  // session). Prefer the shipment id; fall back to the tracking code.
  let match: MatchableShipment | null = null;
  if (easypostShipmentId) {
    const { data, error } = await admin
      .from('carrier_shipments')
      .select('id, organization_id, connection_id')
      .eq('easypost_shipment_id', easypostShipmentId)
      .maybeSingle();
    if (error) {
      void reportError(new Error(error.message), { tag: 'api.webhooks.easypost.lookup' });
      return new NextResponse('Lookup failed', { status: 500 });
    }
    match = (data as MatchableShipment | null) ?? null;
  }
  if (!match && trackingCode) {
    const { data, error } = await admin
      .from('carrier_shipments')
      .select('id, organization_id, connection_id')
      .eq('tracking_code', trackingCode)
      .maybeSingle();
    if (error) {
      void reportError(new Error(error.message), { tag: 'api.webhooks.easypost.lookup' });
      return new NextResponse('Lookup failed', { status: 500 });
    }
    match = (data as MatchableShipment | null) ?? null;
  }

  // Unknown shipment -> 200 no-op. We don't leak whether a row exists, and we
  // stop EasyPost from retrying a stray event.
  if (!match) {
    return NextResponse.json({ received: true, ignored: 'no_shipment_match' });
  }

  // Resolve the webhook secret for THIS shipment's connection (Vault only).
  if (!match.connection_id) {
    // No connection -> we can't verify a signature -> reject as unauthorized.
    return new NextResponse('Invalid signature', { status: 401 });
  }
  const { data: conn, error: connError } = await admin
    .from('org_connections')
    .select('secret_id')
    .eq('id', match.connection_id)
    .maybeSingle();
  if (connError) {
    void reportError(new Error(connError.message), { tag: 'api.webhooks.easypost.connection' });
    return new NextResponse('Connection lookup failed', { status: 500 });
  }
  const secretId = (conn as { secret_id: string | null } | null)?.secret_id ?? null;
  if (!secretId) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  let webhookSecret: string | null = null;
  try {
    const secrets = await getConnectionSecret(admin as never, secretId);
    webhookSecret = typeof secrets.webhookSecret === 'string' ? secrets.webhookSecret : null;
  } catch (e) {
    // Never log the secret/exception body in a way that could carry it; report
    // a tagged, message-only error.
    void reportError(e, { tag: 'api.webhooks.easypost.secret' });
    return new NextResponse('Secret unavailable', { status: 500 });
  }
  if (!webhookSecret) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  // Verify the HMAC over the RAW body. Failure -> 401.
  const sigHeader = req.headers.get(SIGNATURE_HEADER);
  if (!verifySignature(rawBody, webhookSecret, sigHeader)) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  // Signature is valid: apply the tracking update (idempotent last-write).
  const updates: Record<string, unknown> = {};
  if (trackingStatusRaw) updates.tracking_status = trackingStatusRaw;
  if (trackingUrl) updates.tracking_url = trackingUrl;
  const mappedStatus = trackingStatusRaw ? mapTrackingStatus(trackingStatusRaw) : null;
  if (mappedStatus) updates.status = mappedStatus;

  if (Object.keys(updates).length === 0) {
    // Verified, but nothing actionable in the payload -> no-op success.
    return NextResponse.json({ received: true, updated: false });
  }

  const { error: updateError } = await admin
    .from('carrier_shipments')
    .update(updates)
    .eq('id', match.id);
  if (updateError) {
    void reportError(new Error(updateError.message), { tag: 'api.webhooks.easypost.update' });
    return new NextResponse('Update failed', { status: 500 });
  }

  return NextResponse.json({ received: true, updated: true });
}
