import 'server-only';

import { env } from '@/lib/env';

/**
 * Pushes a "permissions changed" ping to the org's realtime broadcast channel
 * after an override write, so open sessions refresh instantly.
 *
 * Why Broadcast (not postgres_changes): postgres_changes filters by the table's
 * RLS, which made delivery fragile here — DELETEs weren't authorized, and the
 * socket's auth goes stale on token refresh ("worked then stopped"). Broadcast
 * is plain pub/sub: the server posts a message to a public channel and every
 * subscriber gets it, regardless of RLS / replica identity / token age. The
 * payload carries only WHO changed (role or userId) — never permission data —
 * so the client can ignore irrelevant pings; the actual permissions are still
 * fetched RLS-protected on refresh.
 *
 * Best-effort: a failed broadcast never throws (the override write already
 * succeeded; the user just falls back to refresh-on-navigate).
 */
export async function broadcastPermissionsChanged(
  organizationId: string,
  target: { role?: string; userId?: string },
): Promise<void> {
  try {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `perms:${organizationId}`,
            event: 'changed',
            payload: target,
            private: false,
          },
        ],
      }),
      // Don't let a slow realtime endpoint hold the action open.
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error('[broadcastPermissionsChanged] failed (non-fatal):', e);
  }
}
