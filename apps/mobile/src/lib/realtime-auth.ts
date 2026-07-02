import { supabase } from '@/lib/supabase';

/**
 * Ensure the realtime socket carries the user's JWT BEFORE a
 * `postgres_changes` channel joins.
 *
 * A subscription's RLS claims are fixed server-side from the token the
 * channel JOINED with (`realtime.subscription.claims_role`). supabase-js
 * pushes the token to the socket on SIGNED_IN / TOKEN_REFRESHED — but NOT
 * on the INITIAL_SESSION restore path, which is how almost every mobile
 * app relaunch resumes. A channel joined in that state registers as
 * `anon`: auth.uid() is NULL, every RLS check fails, and Postgres silently
 * filters out 100% of events while the channel still reports SUBSCRIBED.
 * Same defect diagnosed + fixed on web 2026-07-02
 * (apps/web/src/lib/supabase/realtime-auth.ts).
 */
export async function ensureRealtimeAuth(): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      await supabase.realtime.setAuth(session.access_token);
    }
  } catch {
    // Never block a screen on realtime plumbing — worst case the
    // subscription joins anon and the screen falls back to manual refresh.
  }
}
