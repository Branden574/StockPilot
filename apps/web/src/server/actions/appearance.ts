'use server';

import { z } from 'zod';

import { readVerifiedSessionTokenOf } from '@/lib/auth/verified-claims';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import { createAccessTokenClient } from '@/lib/supabase/access-token-client';
import { createClient } from '@/lib/supabase/server';

import { appearanceModeSchema, isMissingAppearanceTableError } from '@stockpilot/core';

/**
 * A person's own appearance on their account (public.user_appearance, the
 * self-only table of the Liquid Glass plan 3.2). Two actions, both SELF ROW
 * ONLY:
 *   - the browser names the person it believes is signed in (`userId`), and
 *     the action proceeds only when the request's verified session is that
 *     same person (readVerifiedSessionTokenOf), so a session that changed
 *     hands in another tab can never read or write the wrong account's row;
 *   - the read and the write then run on a client that acts as exactly that
 *     verified token (createAccessTokenClient), under the table's own-row RLS
 *     (user_id = auth.uid()), and name only that user_id.
 * The value is validated with zod against the four words before anything is
 * sent; the table's CHECK refuses anything else as well.
 *
 * Answers are what the reconcile reducer (packages/core/src/appearance) needs:
 * the row as the server holds it (so `synced` is only ever claimed when the
 * server answered with it), or a reason. A missing table (the web shipped
 * before the migration) is its own reason, so the page says "saved on this
 * device only" and never claims sync. Nothing here redirects: a signed-out
 * request gets `unauthenticated`, and the page keeps the choice on the device.
 */

const userIdSchema = z.string().uuid();

const setAppearanceSchema = z.object({
  userId: userIdSchema,
  appearance: appearanceModeSchema,
});

export interface AppearanceRowAnswer {
  appearance: string;
  updated_at: string;
}

export type AppearanceActionResult =
  | { ok: true; userId: string; row: AppearanceRowAnswer | null }
  | { ok: false; reason: 'missing-table' | 'unauthenticated' | 'invalid' | 'error' };

async function clientFor(userId: string) {
  const session = await readVerifiedSessionTokenOf(await createClient(), userId);
  return session ? createAccessTokenClient(session.token) : null;
}

/** Read the signed-in person's own row: `row` null when they never chose on an account. */
export async function getMyAppearanceAction(userId: unknown): Promise<AppearanceActionResult> {
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  try {
    const supabase = await clientFor(parsed.data);
    if (!supabase) return { ok: false, reason: 'unauthenticated' };
    const { data, error } = await supabase
      .from('user_appearance')
      .select('appearance, updated_at')
      .eq('user_id', parsed.data)
      .maybeSingle();
    if (error) {
      if (isMissingAppearanceTableError(error)) return { ok: false, reason: 'missing-table' };
      void reportError(error, { tag: 'appearance.read', level: 'warning' });
      return { ok: false, reason: 'error' };
    }
    return { ok: true, userId: parsed.data, row: (data as AppearanceRowAnswer | null) ?? null };
  } catch (e) {
    rethrowControlFlow(e);
    void reportError(e, { tag: 'appearance.read', level: 'warning' });
    return { ok: false, reason: 'error' };
  }
}

/** Store the signed-in person's own appearance and answer with the row the server now holds. */
export async function setMyAppearanceAction(input: unknown): Promise<AppearanceActionResult> {
  const parsed = setAppearanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const { userId, appearance } = parsed.data;
  try {
    const supabase = await clientFor(userId);
    if (!supabase) return { ok: false, reason: 'unauthenticated' };
    const { data, error } = await supabase
      .from('user_appearance')
      .upsert({ user_id: userId, appearance }, { onConflict: 'user_id' })
      .select('appearance, updated_at')
      .single();
    if (error) {
      if (isMissingAppearanceTableError(error)) return { ok: false, reason: 'missing-table' };
      void reportError(error, { tag: 'appearance.save', level: 'warning' });
      return { ok: false, reason: 'error' };
    }
    return { ok: true, userId, row: data as AppearanceRowAnswer };
  } catch (e) {
    rethrowControlFlow(e);
    void reportError(e, { tag: 'appearance.save', level: 'warning' });
    return { ok: false, reason: 'error' };
  }
}
