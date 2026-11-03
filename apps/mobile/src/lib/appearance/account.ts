import {
  isMissingAppearanceTableError,
  type AppearanceFailure,
  type AppearanceMode,
} from '@stockpilot/core';

import { supabase } from '../supabase';

/**
 * The person's own appearance row (public.user_appearance, migration
 * user_appearance: own-row RLS for select, insert and update; no delete).
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
  save(userId: string, mode: AppearanceMode): Promise<AccountAnswer>;
}

const COLUMNS = 'appearance, updated_at';

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

  async save(userId, mode) {
    try {
      // Insert the first time, update after (the trigger moves updated_at).
      // The row comes back, so "Saved to your account" is only ever said
      // after the server answered with exactly what was sent.
      const { data, error } = await supabase
        .from('user_appearance')
        .upsert({ user_id: userId, appearance: mode }, { onConflict: 'user_id' })
        .select(COLUMNS)
        .single();
      if (error) return failure(error);
      return { ok: true, row: data ?? null };
    } catch (error) {
      return failure(error);
    }
  },
};
