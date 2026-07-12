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

export async function recordTourOutcomeAction(
  input: z.input<typeof tourEventSchema>,
): Promise<void> {
  const parsed = tourEventSchema.safeParse(input);
  if (!parsed.success) return;
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
    const { data: row } = await ctx.supabase
      .from('user_onboarding')
      .select('completed_tours, dismissed_tours')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const current = (row?.[field] as Record<string, unknown> | null) ?? {};
    await ctx.supabase.from('user_onboarding').upsert(
      {
        user_id: ctx.userId,
        role_at_onboarding: ctx.role,
        [field]: { ...current, [parsed.data.tourId]: entry },
        last_tour_state: null,
      },
      { onConflict: 'user_id' },
    );
  } catch {
    // Best-effort — losing a completion mark re-offers a tour, never breaks UI.
  }
}

export interface TourStateSnapshot {
  completed: Record<string, { v?: number } | undefined>;
  dismissed: Record<string, { v?: number } | undefined>;
}

export async function getTourStateAction(): Promise<TourStateSnapshot> {
  try {
    const ctx = await withContext();
    const { data } = await ctx.supabase
      .from('user_onboarding')
      .select('completed_tours, dismissed_tours')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    return {
      completed: (data?.completed_tours as TourStateSnapshot['completed']) ?? {},
      dismissed: (data?.dismissed_tours as TourStateSnapshot['dismissed']) ?? {},
    };
  } catch {
    // Fail closed-quiet: treat as "everything seen" is wrong (hides tours
    // forever); treat as "nothing seen" re-offers once — acceptable.
    return { completed: {}, dismissed: {} };
  }
}
