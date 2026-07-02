'use client';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@stockpilot/core';

/**
 * Ensure the realtime socket carries the user's JWT BEFORE any channel
 * joins, and keep it fresh across token refreshes.
 *
 * Why this exists: a `postgres_changes` subscription's RLS claims are
 * fixed server-side from the token the channel JOINED with (visible in
 * `realtime.subscription.claims_role`). The browser client hydrates the
 * auth session asynchronously, so a channel subscribed straight from a
 * mount effect RACES hydration — lose the race and the subscription is
 * registered as `anon`: `auth.uid()` is NULL, every RLS check fails, and
 * Postgres silently filters out 100% of events. No error surfaces — the
 * channel still reports SUBSCRIBED and "Subscribed to PostgreSQL".
 * Diagnosed live 2026-07-02: `realtime.subscription` showed
 * claims_role=anon for exactly the browsers whose watchers never
 * received events, `authenticated` for the ones that worked.
 *
 * The TOKEN_REFRESHED re-push also addresses the known "postgres_changes
 * goes stale on token refresh" failure: Realtime re-evaluates a
 * subscription's claims when the socket pushes a new access_token.
 *
 * Returns an unsubscribe fn for the auth listener; callers push it into
 * their effect cleanup. Never throws on a missing session — an anon join
 * just preserves today's behavior for signed-out edge cases.
 */
export async function ensureRealtimeAuth(
  supabase: SupabaseClient<Database>,
): Promise<() => void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  }
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, s) => {
    if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && s?.access_token) {
      void supabase.realtime.setAuth(s.access_token);
    }
  });
  return () => subscription.unsubscribe();
}
