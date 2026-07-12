'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import {
  PublicLinksService,
  publicLinkSchema,
  type EffectiveCatalogCount,
  type PublicLinkCandidateRow,
} from '@/server/services/public-links';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Thin zod-validated wrappers over PublicLinksService for the Public request
 * links admin UI (P2 of the public-catalog plan). Every action:
 *   1. parses input with zod,
 *   2. asserts `public_links:manage` explicitly (the service's gate() asserts
 *      it again — belt and suspenders, and RLS re-enforces on every write),
 *   3. delegates to the service, which audits and revalidates the
 *      `public-catalog-<linkId>` cache tag itself.
 * Cache-tag invalidation NEVER happens here — the service owns it.
 */

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const SETTINGS_PATH = '/dashboard/settings/public-requests';

async function serviceForManager(): Promise<PublicLinksService> {
  const ctx = await withContext();
  assertPermission(ctx, 'public_links:manage');
  return new PublicLinksService(ctx);
}

function revalidateLinkPages(linkId?: string): void {
  revalidatePath(SETTINGS_PATH);
  if (linkId) revalidatePath(`${SETTINGS_PATH}/${linkId}`);
}

// ── Link CRUD ────────────────────────────────────────────────────────────────

const createLinkSchema = publicLinkSchema.pick({ name: true, purpose: true });

export async function createPublicLinkAction(
  input: z.input<typeof createLinkSchema>,
): Promise<ActionResult<{ id: string; token: string }>> {
  const parsed = createLinkSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'A link name is required.');
  try {
    const svc = await serviceForManager();
    const out = await svc.create(parsed.data);
    revalidateLinkPages(out.id);
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const updateLinkSchema = publicLinkSchema.extend({ id: z.string().uuid() });

export async function updatePublicLinkAction(
  input: z.input<typeof updateLinkSchema>,
): Promise<ActionResult<void>> {
  const parsed = updateLinkSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid link settings.');
  try {
    const svc = await serviceForManager();
    const { id, ...rest } = parsed.data;
    await svc.update(id, rest);
    revalidateLinkPages(id);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const setActiveSchema = z.object({ id: z.string().uuid(), active: z.boolean() });

export async function setPublicLinkActiveAction(
  input: z.input<typeof setActiveSchema>,
): Promise<ActionResult<void>> {
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await serviceForManager();
    await svc.setActive(parsed.data.id, parsed.data.active);
    revalidateLinkPages(parsed.data.id);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const idSchema = z.object({ id: z.string().uuid() });

export async function rotatePublicLinkTokenAction(
  input: z.input<typeof idSchema>,
): Promise<ActionResult<{ token: string }>> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await serviceForManager();
    const out = await svc.rotateToken(parsed.data.id);
    revalidateLinkPages(parsed.data.id);
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Duplicates a link's config + catalog entries under a fresh token. The copy
 * is always created DISABLED — the caller routes the admin to the editor to
 * review before enabling.
 */
export async function duplicatePublicLinkAction(
  input: z.input<typeof idSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await serviceForManager();
    const out = await svc.duplicate(parsed.data.id);
    revalidateLinkPages(out.id);
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

export async function deletePublicLinkAction(
  input: z.input<typeof idSchema>,
): Promise<ActionResult<void>> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await serviceForManager();
    await svc.remove(parsed.data.id);
    revalidateLinkPages(parsed.data.id);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ── Catalog entries (bulk add / remove / per-entry cap) ─────────────────────

const bulkEntriesSchema = z.object({
  linkId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1).max(1000),
  maxQtyPerRequest: z.number().int().positive().max(10_000).nullish(),
});

export async function addPublicLinkEntriesAction(
  input: z.input<typeof bulkEntriesSchema>,
): Promise<ActionResult<{ added: number }>> {
  const parsed = bulkEntriesSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await serviceForManager();
    const out = await svc.addEntries(
      parsed.data.linkId,
      parsed.data.itemIds,
      parsed.data.maxQtyPerRequest ?? null,
    );
    revalidateLinkPages(parsed.data.linkId);
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const removeEntriesSchema = bulkEntriesSchema.omit({ maxQtyPerRequest: true });

export async function removePublicLinkEntriesAction(
  input: z.input<typeof removeEntriesSchema>,
): Promise<ActionResult<{ removed: number }>> {
  const parsed = removeEntriesSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await serviceForManager();
    const out = await svc.removeEntries(parsed.data.linkId, parsed.data.itemIds);
    revalidateLinkPages(parsed.data.linkId);
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const entryCapSchema = z.object({
  linkId: z.string().uuid(),
  itemId: z.string().uuid(),
  /** null clears the per-entry cap back to the link default. */
  maxQtyPerRequest: z.number().int().positive().max(10_000).nullable(),
});

export async function setPublicLinkEntryMaxQtyAction(
  input: z.input<typeof entryCapSchema>,
): Promise<ActionResult<void>> {
  const parsed = entryCapSchema.safeParse(input);
  if (!parsed.success)
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Quantity limit must be a positive whole number.',
    );
  try {
    const svc = await serviceForManager();
    // addEntries upserts on (link_id, item_id), so re-adding IS the cap edit.
    await svc.addEntries(parsed.data.linkId, [parsed.data.itemId], parsed.data.maxQtyPerRequest);
    revalidateLinkPages(parsed.data.linkId);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ── Reads used by the catalog editor ─────────────────────────────────────────

const candidateSearchSchema = z.object({
  linkId: z.string().uuid(),
  search: z.string().trim().max(120).optional(),
  categoryId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  itemType: z.enum(['book', 'item']).optional(),
  warehouseId: z.string().uuid().optional(),
  onLinkOnly: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  sort: z.enum(['name', 'sku', 'created']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

export async function searchPublicLinkCandidatesAction(
  input: z.input<typeof candidateSearchSchema>,
): Promise<ActionResult<{ rows: PublicLinkCandidateRow[]; total: number }>> {
  const parsed = candidateSearchSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid search');
  try {
    const svc = await serviceForManager();
    const { linkId, ...rest } = parsed.data;
    const out = await svc.searchCandidates(linkId, rest);
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const effectiveCountSchema = z.object({ linkId: z.string().uuid() });

export async function getPublicLinkEffectiveCountAction(
  input: z.input<typeof effectiveCountSchema>,
): Promise<ActionResult<EffectiveCatalogCount>> {
  const parsed = effectiveCountSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await serviceForManager();
    return ok(await svc.effectiveCatalogCount(parsed.data.linkId));
  } catch (e) {
    return toResult(e);
  }
}
