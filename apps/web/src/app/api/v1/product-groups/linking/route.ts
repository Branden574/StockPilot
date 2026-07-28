import { NextResponse, type NextRequest } from 'next/server';

import { linkFamilySchema, unlinkItemsSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import {
  assertModuleEnabled,
  assertPermission,
  serviceErrorStatus,
  ServiceError,
} from '@/server/services/context';
import {
  linkFamily,
  suggestFamilies,
  unlinkItems,
} from '@/server/services/product-group-linking';
import { ProductGroupsService } from '@/server/services/product-groups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Bearer twin of the group-linking review tool — the same three operations
 * the web screen drives, so the phone is not a second-class surface (every web
 * feature ships native too).
 *
 * The SHARED zod schemas are the point: `linkFamilySchema` and
 * `unlinkItemsSchema` live in @stockpilot/core and are the exact objects the
 * server action parses, so web and Expo cannot drift on what a legal link is.
 * And because the schema's only member field is an item id, no client can ask
 * this endpoint to apply a heuristic — the opt-in rule is enforced by the
 * shape of the request, not by a convention.
 */

function errorResponse(e: unknown) {
  if (e instanceof ServiceError) {
    return NextResponse.json(
      // `details` carries the sports vocabulary code (ITEM_ALREADY_GROUPED,
      // VARIANT_ALREADY_EXISTS) and the offending item ids when the service set
      // them, so the native client can render the mapped title/action and mark
      // the exact rows rather than showing one blob of text.
      { error: e.code, message: e.message, details: e.details ?? null },
      { status: serviceErrorStatus(e.code) },
    );
  }
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

/** Suggested families. Reads only — nothing here writes. */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`v1-group-linking-suggest:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '25');
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 25;

  try {
    // Suggestions are advisory, but they still enumerate the caller's
    // ungrouped catalog, so they ride the SAME gates the writes do rather than
    // being open to any authenticated member. Asserted here (not in the
    // service) because `suggestFamilies` takes a bare client + org id by
    // design — it is a pure read used from contexts that gate above it.
    assertModuleEnabled(ctx, 'sports');
    assertPermission(ctx, 'sports:manage');
    const suggestions = await suggestFamilies(
      { supabase: ctx.supabase, organizationId: ctx.organizationId },
      {
        categoryId: url.searchParams.get('categoryId'),
        warehouseId: url.searchParams.get('warehouseId'),
        limit,
      },
    );
    return NextResponse.json({ ok: true, suggestions });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Link an EXPLICIT list of item ids into one group. */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Writes are rarer and heavier than the reads above: one call can touch 200
  // rows and emit 200 audit events.
  const rl = await checkRateLimit(`v1-group-linking-write:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'validation_error', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = linkFamilySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    const result = await linkFamily(
      { groups: new ProductGroupsService(ctx), supabase: ctx.supabase, ctx },
      {
        groupId: parsed.data.groupId,
        group: parsed.data.group,
        members: parsed.data.members.map((m) => ({
          itemId: m.itemId,
          variantSize: m.variantSize ?? null,
          variantSizeOriginal: m.variantSizeOriginal ?? null,
          variantSizeSystem: m.variantSizeSystem ?? null,
          jerseyNumber: m.jerseyNumber ?? null,
        })),
        reason: parsed.data.reason,
        force: parsed.data.force,
      },
    );
    // group_id decides how the web list collapses rows; a phone-side link must
    // not leave the web view a TTL behind.
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Undo a link. Same gates as POST. */
export async function DELETE(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`v1-group-linking-write:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'validation_error', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = unlinkItemsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    const result = await unlinkItems({ supabase: ctx.supabase, ctx }, parsed.data);
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
