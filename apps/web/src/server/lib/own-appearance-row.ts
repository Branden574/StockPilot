import 'server-only';

import { z } from 'zod';

import { readVerifiedSessionTokenOf } from '@/lib/auth/verified-claims';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { createClient } from '@/lib/supabase/server';

import { isMissingAppearanceTableError } from '@stockpilot/core';

/**
 * A person's own row of public.user_appearance, as the server reads it: the
 * ONE read behind both ways in, the server action getMyAppearanceAction
 * (server/actions/appearance.ts) and the route POST /api/appearance/account,
 * which the browser uses (a plain request: a server action pending on load
 * holds the hydration of the page's streamed content and a client redirect;
 * measured 2026-11-11). The save in the action module takes its client from
 * here too, so the read and the write name the session the same way.
 *
 * SELF ROW ONLY, as the action module says: the caller names the person the
 * browser believes is signed in, the read proceeds only when the request's
 * verified session is that same person (readVerifiedSessionTokenOf), and it
 * runs on a client that acts as exactly that verified token
 * (createAccessTokenClient), under the table's own-row RLS, naming only that
 * user_id.
 *
 * Not a module of server actions: nothing here is something a browser can call.
 */

export const appearanceUserIdSchema = z.string().uuid();

/** The columns read back: the row as the server holds it. */
export const APPEARANCE_ROW_COLUMNS = 'style, theme, updated_at';

export interface OwnAppearanceRow {
  style: string | null;
  theme: string | null;
  updated_at: string;
}

export type OwnAppearanceAnswer =
  | { ok: true; userId: string; row: OwnAppearanceRow | null }
  | { ok: false; reason: 'missing-table' | 'unauthenticated' | 'invalid' | 'error' };

/** The part of the cookie client the session is verified on. */
type SessionReader = Parameters<typeof readVerifiedSessionTokenOf>[0];

/**
 * A client that acts as `userId`'s verified token, or null when the request's
 * session is not that person's. `cookieClient` is the request's cookie client
 * when the caller already built one (the route, which validates the user on
 * it first), so the session is read on one client.
 */
export async function ownAppearanceClientFor(userId: string, cookieClient?: SessionReader) {
  const session = await readVerifiedSessionTokenOf(cookieClient ?? (await createClient()), userId);
  return session ? createAccessTokenClient(session.token) : null;
}

/** Read the signed-in person's own row: `row` null when they never chose on an account. */
export async function readOwnAppearanceRow(
  userId: unknown,
  cookieClient?: SessionReader,
): Promise<OwnAppearanceAnswer> {
  const parsed = appearanceUserIdSchema.safeParse(userId);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  try {
    const supabase = await ownAppearanceClientFor(parsed.data, cookieClient);
    if (!supabase) return { ok: false, reason: 'unauthenticated' };
    const { data, error } = await supabase
      .from('user_appearance')
      .select(APPEARANCE_ROW_COLUMNS)
      .eq('user_id', parsed.data)
      .maybeSingle();
    if (error) {
      if (isMissingAppearanceTableError(error)) return { ok: false, reason: 'missing-table' };
      void reportError(error, { tag: 'appearance.read', level: 'warning' });
      return { ok: false, reason: 'error' };
    }
    return { ok: true, userId: parsed.data, row: (data as OwnAppearanceRow | null) ?? null };
  } catch (e) {
    rethrowControlFlow(e);
    void reportError(e, { tag: 'appearance.read', level: 'warning' });
    return { ok: false, reason: 'error' };
  }
}
