import type { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  storefrontError,
  storefrontJson,
  storefrontRateLimited,
  storefrontUnauthenticated,
} from '@/server/lib/order-storefront-http';
import { OrderStorefrontService } from '@/server/services/order-storefront';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the phone's storefront needs once, on open (phone ordering PO-3; plan
 * 3.1). Bearer (the phone) or cookie; every read is the caller's own
 * (ctx.supabase), never the cookie client.
 *
 * Gates first: the Orders module, the MFA step-up, orders:request (403
 * module_disabled / forbidden with details.reason module_disabled,
 * aal2_required, mfa_required or permission, in core's words).
 *
 * 200 { organizationId, enabled: false, message, serverNow }
 *       ORDERS_PHONE_STOREFRONT=off on the server: nothing else is read.
 * 200 { organizationId, enabled: true, serverNow, warehouses: [{ id, name }],
 *       viewer: { userId, role, name, email, canOrderOnBehalf,
 *                 canApproveOrders },
 *       kitsEnabled, orgTimezone (as stored, or null),
 *       deliveryRecipients: { to, cc, toName, ccName } | null,
 *       recentRequesters: { status: 'ok', people } | { status: 'error' } | null }
 *     recentRequesters is null unless the caller holds orders:approve, and
 *     answers { status: 'error' } past 2.5 s.
 * 401 unauthenticated; 429 rate_limited (retry-after; order-storefront:<user>,
 * 120 a minute, shared with the catalog); 500 internal_error (core's
 * read-failed sentence, details.reason 'failed').
 * Every answer is private, no-store, and names the organization.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return storefrontUnauthenticated();

  const rl = await checkRateLimit(`order-storefront:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) return storefrontRateLimited(rl.resetAt, ctx.organizationId);

  try {
    return storefrontJson(await new OrderStorefrontService(ctx).storefront());
  } catch (e) {
    return storefrontError(e, ctx.organizationId, 'api.v1.orders.storefront');
  }
}
