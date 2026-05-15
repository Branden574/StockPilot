'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  NOTIFICATION_PREF_KEYS,
  type NotificationPrefKey,
  type NotificationPreferences,
} from '@/lib/notification-prefs';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

const updateSchema = z
  .object(
    Object.fromEntries(
      NOTIFICATION_PREF_KEYS.map((k) => [k, z.boolean().optional()]),
    ) as Record<NotificationPrefKey, z.ZodOptional<z.ZodBoolean>>,
  )
  .strict();

/**
 * Server-side fetch of the calling user's notification_preferences
 * row, defaulting every column to true when the row is missing (mirrors
 * the table's column defaults). Used by the Notifications settings
 * page to seed the toggle UI.
 */
export async function loadNotificationPreferences(): Promise<NotificationPreferences> {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const { data } = await supabase
    .from('notification_preferences')
    .select(NOTIFICATION_PREF_KEYS.join(', '))
    .eq('user_id', ctx.userId)
    .maybeSingle();
  const row = (data ?? {}) as Partial<NotificationPreferences>;
  return Object.fromEntries(
    NOTIFICATION_PREF_KEYS.map((k) => [k, row[k] ?? true]),
  ) as NotificationPreferences;
}

/**
 * Update any subset of the calling user's notification preferences.
 * Uses an upsert (with `user_id` as the conflict target) so the first
 * write for a user who somehow lacks a row creates it; in steady state
 * the bootstrap trigger guarantees the row already exists.
 *
 * Emits a `notification_preference.updated` audit row with the list of
 * changed keys in `extra.changed_keys` so we keep a forensic trail of
 * who muted what and when.
 */
export async function updateNotificationPreferencesAction(
  input: Partial<NotificationPreferences>,
): Promise<ActionResult<{ changed: number }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid preference keys.',
    );
  }
  // Drop undefined entries so we don't clobber existing values with NULL.
  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => typeof v === 'boolean'),
  ) as Partial<NotificationPreferences>;
  const changedKeys = Object.keys(patch);
  if (changedKeys.length === 0) {
    return ok({ changed: 0 });
  }

  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();

    // Load existing values for the audit before/after diff. Defaults
    // to true on missing row to match column defaults.
    const { data: prev } = await supabase
      .from('notification_preferences')
      .select(changedKeys.join(', '))
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const prevRow = (prev ?? {}) as Partial<NotificationPreferences>;
    const before: Partial<NotificationPreferences> = {};
    for (const k of changedKeys) {
      before[k as NotificationPrefKey] = prevRow[k as NotificationPrefKey] ?? true;
    }

    const { error } = await supabase
      .from('notification_preferences')
      .upsert(
        { user_id: ctx.userId, ...patch },
        { onConflict: 'user_id' },
      );
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'notification_preference.updated',
      entityType: 'user',
      entityId: ctx.userId,
      before,
      after: patch,
      extra: { changed_keys: changedKeys },
    });

    revalidatePath('/dashboard/settings/notifications');
    return ok({ changed: changedKeys.length });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
