import 'server-only';

import { env } from '@/lib/env';

/**
 * Posts a Realtime Broadcast message to a public channel (best-effort; never
 * throws). Plain pub/sub — no RLS/replica-identity/token dependency. Callers
 * carry only non-sensitive routing data in `payload`.
 */
export async function broadcastToChannel(
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error(`[broadcastToChannel ${topic}/${event}] failed (non-fatal):`, e);
  }
}

/**
 * Order-change ping so other open Orders screens (web + mobile) refetch — e.g.
 * when a picker is claimed/assigned/released so the "Being picked by X" status
 * updates live for everyone, not just the acting user. Best-effort; carries only
 * the order id (no sensitive data). Subscribers listen on `orders:{org}`.
 */
export async function broadcastOrderChanged(
  organizationId: string,
  orderId: string,
): Promise<void> {
  await broadcastToChannel(`orders:${organizationId}`, 'changed', { orderId });
}

/** Permission-change ping (mig 0207+). See reference_realtime_permission_push_broadcast. */
export async function broadcastPermissionsChanged(
  organizationId: string,
  target: { role?: string; userId?: string },
): Promise<void> {
  await broadcastToChannel(`perms:${organizationId}`, 'changed', target);
}
