'use server';

import { revalidatePath } from 'next/cache';

import { withContext } from '@/server/services/context';

/** Persist the Getting-started dismissal cross-device (mig 0257). */
export async function dismissOnboardingAction(): Promise<void> {
  try {
    const ctx = await withContext();
    await ctx.supabase
      .from('user_profiles')
      .update({ onboarding_dismissed_at: new Date().toISOString() })
      .eq('id', ctx.userId);
    revalidatePath('/dashboard');
  } catch {
    // Best-effort — the panel is already hidden optimistically client-side.
  }
}
