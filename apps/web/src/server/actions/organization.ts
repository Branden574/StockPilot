'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { slugify } from '@/lib/utils';

import {
  createOrganizationSchema,
  err,
  ok,
  type ActionResult,
  type CreateOrganizationInput,
} from '@stockpilot/core';

/**
 * Bootstraps a new organization. Uses the admin (service-role) client because:
 *   - The current user can't be an org member of an org that doesn't exist yet,
 *     so RLS would reject the INSERT.
 *   - We bind the membership to `session.userId` taken from the validated
 *     server session, NOT from any client input — so this remains safe.
 */
export async function createOrganizationAction(
  input: CreateOrganizationInput,
): Promise<ActionResult<{ organizationId: string; slug: string }>> {
  const session = await requireSession();

  const parsed = createOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err(
      'internal_error',
      'Server is missing SUPABASE_SERVICE_ROLE_KEY. Add it to apps/web/.env.local and restart the dev server.',
    );
  }

  const candidateSlug = parsed.data.slug?.length ? parsed.data.slug : slugify(parsed.data.name);
  const slug = await ensureUniqueSlug(candidateSlug, admin);

  // 1) Insert the org.
  const { data: org, error: orgError } = await admin
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

  const orgId = org.id as string;
  const orgSlug = org.slug as string;

  // 2) Add the creator as owner.
  const { error: memberError } = await admin.from('organization_members').insert({
    organization_id: orgId,
    user_id: session.userId,
    role: 'owner',
    accepted_at: new Date().toISOString(),
  });

  if (memberError) {
    // Best-effort cleanup — try to roll back the org so the user can retry.
    await admin.from('organizations').delete().eq('id', orgId);
    return err('internal_error', memberError.message);
  }

  // 3) Set as default org on the user profile.
  await admin
    .from('user_profiles')
    .update({ default_organization_id: orgId })
    .eq('id', session.userId);

  // 4) Seed a default location so the user can immediately add items.
  await admin.from('locations').insert({
    organization_id: orgId,
    name: 'Main Warehouse',
    type: 'warehouse',
  });

  revalidatePath('/dashboard');
  return ok({ organizationId: orgId, slug: orgSlug });
}

const terminologySchema = z.object({
  charter_singular: z.string().min(1).max(40).trim(),
  charter_plural: z.string().min(1).max(40).trim(),
  warehouse_singular: z.string().min(1).max(40).trim(),
  warehouse_plural: z.string().min(1).max(40).trim(),
});

export type TerminologyInput = z.infer<typeof terminologySchema>;

export async function updateTerminologyAction(
  input: TerminologyInput,
): Promise<ActionResult<void>> {
  const parsed = terminologySchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only admins can change terminology.');
    }

    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle();

    const { error } = await supabase
      .from('organizations')
      .update({ terminology: parsed.data })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'warehouse.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { terminology: prev?.terminology ?? null },
      after: { terminology: parsed.data },
    });

    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const poTermsSchema = z.object({
  // Empty string is allowed — we coerce it to null so the PDF skips the
  // terms block. 2000 chars matches the zod schema in @stockpilot/core.
  poTerms: z.string().max(2000).nullable(),
});

export type UpdatePoTermsInput = z.infer<typeof poTermsSchema>;

export async function updateOrgPoTermsAction(
  input: UpdatePoTermsInput,
): Promise<ActionResult<void>> {
  const parsed = poTermsSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid PO terms',
    );
  }
  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can edit PO terms.');
    }
    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('po_terms')
      .eq('id', ctx.organizationId)
      .maybeSingle();

    // Trim + collapse-empty so a textarea full of whitespace clears the
    // terms block rather than rendering a hollow heading on every PO.
    const next =
      parsed.data.poTerms === null
        ? null
        : parsed.data.poTerms.trim().length === 0
          ? null
          : parsed.data.poTerms;

    if (((prev as { po_terms?: string | null } | null)?.po_terms ?? null) === next) {
      return ok(undefined);
    }

    const { error } = await supabase
      .from('organizations')
      .update({ po_terms: next })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'warehouse.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { po_terms: (prev as { po_terms?: string | null } | null)?.po_terms ?? null },
      after: { po_terms: next },
    });

    revalidatePath('/dashboard/settings/organization');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const renameSchema = z.object({ name: z.string().min(1).max(80).trim() });

export async function renameOrganizationAction(input: {
  name: string;
}): Promise<ActionResult<void>> {
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid name',
    );
  }
  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can rename the org.');
    }
    const supabase = await createClient();
    const { data: prev } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', ctx.organizationId)
      .maybeSingle();

    if ((prev?.name as string | undefined) === parsed.data.name) {
      return ok(undefined);
    }

    const { error } = await supabase
      .from('organizations')
      .update({ name: parsed.data.name })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'warehouse.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { name: prev?.name ?? null },
      after: { name: parsed.data.name },
    });

    // The org name shows in the topbar/sidebar via DashboardShell,
    // which is rendered from the (dashboard) layout — revalidate at
    // layout level so the change appears everywhere immediately.
    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

async function ensureUniqueSlug(
  base: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string> {
  let candidate = base || `org-${Date.now()}`;
  let suffix = 0;

  while (true) {
    const { data } = await admin
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
