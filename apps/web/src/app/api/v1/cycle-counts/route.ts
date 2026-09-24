import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';

import { parseCycleCountStatusFilter } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET: one page of the cycle-count history for the phone. The same
 * CycleCountsService.listPage() the web list page renders, so both platforms
 * page, search and scope identically (25 sessions per page, newest first).
 *
 *   ?q=        search: "CC-000042" / "cc-42" / "000042" / "42" find that exact
 *              count; other text matches notes and warehouse names literally
 *   ?page=     1-based; the response carries the EFFECTIVE page (a page past
 *              the end is answered with the last real page)
 *   ?status=   in_progress | completed | canceled (anything else = all)
 *   ?assigned= me | unassigned | <member uuid>
 *   ?warehouseId=<uuid>
 *   ?summary=1 also return the in-progress and started-today totals for the
 *              caller's scope (the phone's tiles)
 *
 * The response echoes organizationId so the phone can drop a late answer
 * that belongs to a workspace it has since switched away from. Never cached:
 * it is per user and changes as counts are started and posted.
 */
const listQuerySchema = z.object({
  q: z.string().max(200, 'Search is too long.').optional(),
  page: z.string().max(12).optional(),
  status: z.string().max(20).optional(),
  assigned: z
    .union([z.literal('me'), z.literal('unassigned'), z.string().uuid()])
    .optional(),
  warehouseId: z.string().uuid().optional(),
  summary: z.enum(['0', '1']).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const params = new URL(req.url).searchParams;
    const raw: Record<string, string> = {};
    for (const key of ['q', 'page', 'status', 'assigned', 'warehouseId', 'summary'] as const) {
      const v = params.get(key);
      if (v !== null) raw[key] = v;
    }
    const parsed = listQuerySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid query' },
        { status: 400 },
      );
    }
    const { q, page, status, assigned, warehouseId, summary } = parsed.data;

    const svc = new CycleCountsService(ctx);
    const result = await svc.listPage(
      {
        q: q ?? null,
        page: page ?? null,
        status: parseCycleCountStatusFilter(status),
        warehouseId: warehouseId ?? null,
        assignedTo: assigned === 'me' ? ctx.userId : assigned && assigned !== 'unassigned' ? assigned : null,
        unassigned: assigned === 'unassigned',
      },
      { includeSummary: summary === '1' },
    );
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.cycle_counts.list' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * Mobile create-count endpoint. The mobile app has no server actions, so
 * starting a cycle count (whole-warehouse or hand-picked selection) goes
 * through here with the standard Bearer-token auth. Mirrors
 * startCycleCountAction on the web.
 */
const bodySchema = z
  .object({
    // 'group' counts a product group BY VARIANT: the service expands each
    // group to its variant items and the count runs as a selection. A group
    // never becomes a countable line of its own — it owns no quantity.
    scope: z.enum(['warehouse', 'selection', 'group']).default('selection'),
    warehouseId: z.string().uuid().nullable().optional(),
    itemIds: z.array(z.string().uuid()).max(1000).optional(),
    groupIds: z.array(z.string().uuid()).max(200).optional(),
    notes: z.string().max(2000).optional().nullable(),
    assignedTo: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.scope !== 'selection' || (v.itemIds?.length ?? 0) > 0, {
    message: 'Pick at least one item to count.',
    path: ['itemIds'],
  })
  .refine((v) => v.scope !== 'group' || (v.groupIds?.length ?? 0) > 0, {
    message: 'Pick at least one product group to count.',
    path: ['groupIds'],
  });

export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }

    const svc = new CycleCountsService(ctx);
    const result = await svc.start({
      scope: parsed.data.scope,
      warehouseId: parsed.data.warehouseId ?? null,
      itemIds: parsed.data.itemIds,
      groupIds: parsed.data.groupIds,
      notes: parsed.data.notes ?? null,
      assignedTo: parsed.data.assignedTo ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'not_found'
          ? 404
          : e.code === 'validation_error'
            ? 400
            : e.code === 'forbidden' || e.code === 'module_disabled'
              ? 403
              : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.cycle_counts.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
