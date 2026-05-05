'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

const nameSchema = z.object({
  fullName: z.string().min(1).max(80).trim().nullable(),
});

export async function updateProfileNameAction(input: {
  fullName: string | null;
}): Promise<ActionResult<void>> {
  const parsed = nameSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid name',
    );
  }
  try {
    const session = await requireSession();
    const supabase = await createClient();
    const { error } = await supabase
      .from('user_profiles')
      .update({ full_name: parsed.data.fullName })
      .eq('id', session.userId);
    if (error) throw new ServiceError('internal_error', error.message);
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const urlSchema = z.object({
  url: z.string().url().nullable(),
});

/**
 * Persists a new avatar_url on the user_profile. The actual file upload
 * happens client-side via supabase.storage; this just records the URL
 * the bucket handed back. Pass null to clear the avatar.
 */
export async function setAvatarUrlAction(input: {
  url: string | null;
}): Promise<ActionResult<void>> {
  const parsed = urlSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Invalid URL');
  }
  try {
    const session = await requireSession();
    const supabase = await createClient();
    const { error } = await supabase
      .from('user_profiles')
      .update({ avatar_url: parsed.data.url })
      .eq('id', session.userId);
    if (error) throw new ServiceError('internal_error', error.message);
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Persists a new logo_url on the organization. Owner/admin only. Same
 * upload-then-record split as setAvatarUrlAction.
 */
export async function setOrgLogoUrlAction(input: {
  url: string | null;
}): Promise<ActionResult<void>> {
  const parsed = urlSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', 'Invalid URL');
  }
  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can change the logo.');
    }
    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const { error } = await supabase
      .from('organizations')
      .update({ logo_url: parsed.data.url })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'warehouse.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { logo_url: prev?.logo_url ?? null },
      after: { logo_url: parsed.data.url },
    });
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
