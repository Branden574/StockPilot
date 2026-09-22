'use server';

import { z } from 'zod';

import { withContext } from '@/server/services/context';

/**
 * Onboarding state persistence (mig 0259, spec §13). Backend-stored so
 * progress survives refresh, sessions, and devices. RLS restricts every
 * row to its owner; these actions run as the user (ctx.supabase).
 */

const tourEventSchema = z.object({
  tourId: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  outcome: z.enum(['completed', 'dismissed']),
});

/**
 * What recording an outcome did. On success it names the user the row was
 * written for, so the browser's once-per-session copy of the tour state
 * (lib/onboarding/tour-state-cache.ts) is only ever updated for that same
 * person.
 */
export type TourOutcomeResult = { ok: true; userId: string } | { ok: false };

export async function recordTourOutcomeAction(
  input: z.input<typeof tourEventSchema>,
): Promise<TourOutcomeResult> {
  const parsed = tourEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const ctx = await withContext();
    const field = parsed.data.outcome === 'completed' ? 'completed_tours' : 'dismissed_tours';
    const entry = {
      v: parsed.data.version,
      at: new Date().toISOString(),
      platform: 'web',
    };
    // Read-modify-write on the user's own row (RLS-scoped). Two concurrent
    // tours racing is harmless — last write wins on independent keys is the
    // worst case and both writes carry full maps read moments apart.
    const { data: row, error: readError } = await ctx.supabase
      .from('user_onboarding')
      .select('completed_tours, dismissed_tours')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    // postgrest-js RESOLVES a failed read ({ data: null, error }). Treating
    // that as "no tours yet" would upsert `{ [tourId]: entry }` over the
    // whole map below and erase every other tour this person already
    // finished or dismissed, so every one of them would be offered again.
    if (readError) return { ok: false };
    const current = (row?.[field] as Record<string, unknown> | null) ?? {};
    const { error: writeError } = await ctx.supabase.from('user_onboarding').upsert(
      {
        user_id: ctx.userId,
        role_at_onboarding: ctx.role,
        [field]: { ...current, [parsed.data.tourId]: entry },
        last_tour_state: null,
      },
      { onConflict: 'user_id' },
    );
    if (writeError) return { ok: false };
    return { ok: true, userId: ctx.userId };
  } catch {
    // Best-effort — losing a completion mark re-offers a tour, never breaks UI.
    return { ok: false };
  }
}

// What's New no longer reads or writes through server actions. It is read by
// tabs that are one deployment BEHIND, and a server action's id changes with
// every build, so an old tab calling one gets "Failed to find Server Action".
// See app/api/v1/me/releases/route.ts and lib/updates/update-store.ts. The
// legacy seen-map that mobile uses is written by app/api/v1/me/announcements.

export interface TourStateSnapshot {
  completed: Record<string, { v?: number } | undefined>;
  dismissed: Record<string, { v?: number } | undefined>;
}

/**
 * A read that says whether it worked and for whom. `ok: false` still carries
 * empty maps, so a server caller (the Help page) keeps rendering "nothing
 * checked yet" exactly as before; the browser cache (tour-state-cache.ts)
 * must know the difference, because a failed read must never be kept for
 * the rest of the session.
 */
export type TourStateRead =
  | (TourStateSnapshot & { ok: true; userId: string })
  | (TourStateSnapshot & { ok: false; userId: null });

function failedTourStateRead(): TourStateRead {
  return { ok: false, userId: null, completed: {}, dismissed: {} };
}

export async function getTourStateAction(): Promise<TourStateRead> {
  try {
    const ctx = await withContext();
    const { data, error } = await ctx.supabase
      .from('user_onboarding')
      .select('completed_tours, dismissed_tours')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    // postgrest-js resolves failures instead of throwing; an unread row is
    // not the same answer as "no row yet" (a person who has never seen a
    // tour), so it must not be reported as one.
    if (error) return failedTourStateRead();
    return {
      ok: true,
      userId: ctx.userId,
      completed: (data?.completed_tours as TourStateSnapshot['completed']) ?? {},
      dismissed: (data?.dismissed_tours as TourStateSnapshot['dismissed']) ?? {},
    };
  } catch {
    // Never answer "everything seen" (that would hide tours for good), and
    // no longer "nothing seen" either: say the read failed. The Help page
    // still shows nothing checked; the browser offers nothing this time and
    // asks again on the next page view.
    return failedTourStateRead();
  }
}
