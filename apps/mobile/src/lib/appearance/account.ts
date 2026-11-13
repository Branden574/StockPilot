import {
  isMissingAppearanceTableError,
  isUserId,
  type AppearanceFailure,
  type AppearancePatch,
} from '@stockpilot/core';

import { supabase } from '../supabase';

/**
 * The person's own appearance row (public.user_appearance, migration
 * user_appearance: own-row RLS for select, insert and update; no delete).
 * Two nullable columns, `style` (the Design) and `theme` (revision R3): null
 * means "not chosen on any device".
 *
 * The phone reaches it the way it reaches the other user-owned preference
 * tables (user_onboarding in onboarding.ts): straight through the signed-in
 * Supabase client. It is the person's own preference, not org-permissioned
 * inventory, so it does not go through /api/v1. Every call names the signed-in
 * person's id and RLS refuses any other row anyway: one person's choice is
 * never read or written under another account.
 *
 * Answers are raw: the core reducer parses the row (parseAccountRow), so a
 * malformed or unknown value is dropped there, never adopted.
 */

export type AccountAnswer = { ok: true; row: unknown } | { ok: false; reason: AppearanceFailure };

/** The read and write the appearance controller performs (injectable for tests). */
export interface AppearanceAccount {
  fetch(userId: string): Promise<AccountAnswer>;
  /** Upsert exactly these columns; the answer is the whole row. */
  save(userId: string, axes: AppearancePatch): Promise<AccountAnswer>;
}

const COLUMNS = 'style, theme, updated_at';

function failure(error: unknown): AccountAnswer {
  return { ok: false, reason: isMissingAppearanceTableError(error) ? 'missing-table' : 'error' };
}

export const supabaseAppearanceAccount: AppearanceAccount = {
  async fetch(userId) {
    try {
      const { data, error } = await supabase
        .from('user_appearance')
        .select(COLUMNS)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) return failure(error);
      // No row is an answer too (rule 4d): the reducer keeps the device value.
      return { ok: true, row: data ?? null };
    } catch (error) {
      return failure(error);
    }
  },

  async save(userId, axes) {
    try {
      // Insert the first time, update after (the trigger moves updated_at).
      // Only the axes given are named, so PostgREST's merge upsert leaves the
      // other column as it is: a Theme saved here never clears a Design saved
      // on the web. The whole row comes back: the reducer checks the axes
      // sent and adopts the other one from it (round 2, finding 6), and
      // "Saved to your account" is only ever said after the server answered
      // with exactly what was sent.
      const values: { user_id: string } & AppearancePatch = { user_id: userId };
      if (axes.style !== undefined) values.style = axes.style;
      if (axes.theme !== undefined) values.theme = axes.theme;
      const { data, error } = await supabase
        .from('user_appearance')
        .upsert(values, { onConflict: 'user_id' })
        .select(COLUMNS)
        .single();
      if (error) return failure(error);
      return { ok: true, row: data ?? null };
    } catch (error) {
      return failure(error);
    }
  },
};

/**
 * Who is signed in on this phone, from the stored session alone, for the
 * first start of the new JS (round 2, finding 10; item 31): a phone with no
 * appearance record of its own waits for its person's row, inside the same
 * 4 s as the font gate, before the first paint. AuthProvider is not mounted
 * yet at that point, so this reads what it will read (getSession) and the
 * same assurance check it makes (the JWT's AAL, decoded locally): a session
 * that still owes its authenticator code is not signed in yet and is not
 * read for. Anything unexpected is nobody: the rollout default shows and the
 * session bridge reports the person after the first paint, as before.
 */
export async function peekSignedInUser(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id;
    if (!isUserId(userId)) return null;
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') return null;
    return userId;
  } catch {
    return null;
  }
}
