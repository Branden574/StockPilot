'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { slugify } from '@/lib/utils';

import {
  createOrganizationSchema,
  err,
  ok,
  type ActionResult,
  type CreateOrganizationInput,
} from '@stockpilot/core';

export async function createOrganizationAction(
  input: CreateOrganizationInput,
): Promise<ActionResult<{ organizationId: string; slug: string }>> {
  const session = await requireSession();

  const parsed = createOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const supabase = await createClient();

  const candidateSlug = parsed.data.slug?.length ? parsed.data.slug : slugify(parsed.data.name);
  const slug = await ensureUniqueSlug(candidateSlug, supabase);

  // 1) Insert the org. The user must be authenticated (RLS policy allows insert).
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert({
      name: parsed.data.name,
      slug,
      industry: parsed.data.industry ?? null,
      size: parsed.data.size ?? null,
      timezone: parsed.data.timezone,
      currency: parsed.data.currency,
    })
    .select('id, slug')
    .single();

  if (orgError || !org) {
    return err('internal_error', orgError?.message ?? 'Failed to create organization');
  }

  // 2) Add the creator as owner.
  const { error: memberError } = await supabase.from('organization_members').insert({
    organization_id: org.id as string,
    user_id: session.userId,
    role: 'owner',
    accepted_at: new Date().toISOString(),
  });

  if (memberError) {
    return err('internal_error', memberError.message);
  }

  // 3) Set as default org on the user profile.
  await supabase
    .from('user_profiles')
    .update({ default_organization_id: org.id as string })
    .eq('id', session.userId);

  // 4) Seed a default location so the user can immediately add items.
  await supabase.from('locations').insert({
    organization_id: org.id as string,
    name: 'Main Warehouse',
    type: 'warehouse',
  });

  revalidatePath('/dashboard');
  return ok({ organizationId: org.id as string, slug: org.slug as string });
}

async function ensureUniqueSlug(
  base: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string> {
  let candidate = base || `org-${Date.now()}`;
  let suffix = 0;

  while (true) {
    const { data } = await supabase
      .from('organizations')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
    if (suffix > 50) {
      candidate = `${base}-${Math.random().toString(36).slice(2, 7)}`;
      return candidate;
    }
  }
}
