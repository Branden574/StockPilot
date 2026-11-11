'use server';

import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError } from '@/lib/error-reporter';
import {
  APPEARANCE_ROW_COLUMNS,
  appearanceUserIdSchema,
  ownAppearanceClientFor,
  readOwnAppearanceRow,
  type OwnAppearanceAnswer,
  type OwnAppearanceRow,
} from '@/server/lib/own-appearance-row';

import {
  appearanceStyleSchema,
  isMissingAppearanceTableError,
  themeSettingSchema,
} from '@stockpilot/core';

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
 * Two nullable columns (plans/REVISION-DEFAULT.md R3): the Design (`style`:
 * liquid-glass or classic) and the Theme (light, dark or system). A save
 * names one or both, validated with zod before anything is sent (the table's
 * CHECKs refuse anything else as well), and upserts ONLY the columns it names:
 * PostgREST's merge upsert leaves the others as they are, so a Theme saved on
 * one device never clears a Design saved on another.
 *
 * Answers are what the reconcile reducer (packages/core/src/appearance) needs:
 * the row as the server holds it (so `synced` is only ever claimed when the
 * server answered with it), or a reason. A missing table (the web shipped
 * before the migration) is its own reason, so the page says "saved on this
 * device only" and never claims sync. Nothing here redirects: a signed-out
 * request gets `unauthenticated`, and the page keeps the choice on the device.
 *
 * THE BROWSER NEVER CALLS THE READ ACTION. A server action pending on load
 * holds the hydration of the page's streamed content and a client redirect
 * (measured 2026-11-11), and the provider reads the row on every signed-in
 * load. So the browser reads by a plain request, POST /api/appearance/account,
 * which answers from the same server function as the read action here
 * (server/lib/own-appearance-row.ts); src/test/appearance-account-read.guard
 * .test.ts keeps every other module from importing the read action. The save
 * stays an action: it only runs when a person chooses.
 */

const setAppearanceSchema = z
  .object({
    userId: appearanceUserIdSchema,
    style: appearanceStyleSchema.optional(),
    theme: themeSettingSchema.optional(),
  })
  .refine((v) => v.style !== undefined || v.theme !== undefined, {
    message: 'a Design, a Theme, or both',
  });

/** The row as the server holds it (server/lib/own-appearance-row.ts). */
export type AppearanceRowAnswer = OwnAppearanceRow;

/** What the read, the save and POST /api/appearance/account answer. */
export type AppearanceActionResult = OwnAppearanceAnswer;

/**
 * Read the signed-in person's own row: `row` null when they never chose on an
 * account. The same read as POST /api/appearance/account; no module the
 * browser loads imports this one (see above).
 */
export async function getMyAppearanceAction(userId: unknown): Promise<AppearanceActionResult> {
  return readOwnAppearanceRow(userId);
}

/**
 * Store the signed-in person's own Design and/or Theme (only the ones given)
 * and answer with the whole row the server now holds.
 */
export async function setMyAppearanceAction(input: unknown): Promise<AppearanceActionResult> {
  const parsed = setAppearanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const { userId, style, theme } = parsed.data;
  const columns: { user_id: string; style?: string; theme?: string } = { user_id: userId };
  if (style !== undefined) columns.style = style;
  if (theme !== undefined) columns.theme = theme;
  try {
    const supabase = await ownAppearanceClientFor(userId);
    if (!supabase) return { ok: false, reason: 'unauthenticated' };
    const { data, error } = await supabase
      .from('user_appearance')
      .upsert(columns, { onConflict: 'user_id' })
      .select(APPEARANCE_ROW_COLUMNS)
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
