import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import { countRowsWithImages } from '@/lib/exports/export-images';
import {
  buildInventoryExportSourceRows,
  type InventoryExportFilters,
} from '@/lib/inventory-export';
import { ServiceError } from '@/server/services/context';
import type { ItemListSort } from '@/server/services/inventory';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Export PREVIEW: sample rows and readiness counts for the export builder.
 *
 * It generates no file. The dialog fetches this ONCE per scope/filter change
 * and formats the sample locally through the field registry, so toggling a
 * field or dragging a column re-renders the preview with zero requests.
 *
 * Its own rate-limit key, deliberately: the export budget is 40/hour and
 * fail-closed because generating a PDF is expensive. A preview is one list
 * query, and charging it to the same budget would let a user lock themselves
 * out of exporting by opening the dialog a few times.
 */
const EXPORT_PREVIEW_LIMIT = 10;

const bodySchema = z.object({
  scope: z.enum(['selected', 'filtered', 'all']),
  itemType: z.enum(['product', 'book', 'asset', 'consumable', 'all']).default('all'),
  ids: z.array(z.string().uuid()).max(10_000).optional(),
  filters: z
    .object({
      q: z.string().optional(),
      status: z.enum(['active', 'archived', 'discontinued', 'all']).optional(),
      stock: z.enum(['low', 'out']).nullable().optional(),
      expected: z.boolean().optional(),
      sort: z.string().optional(),
      categoryIds: z.array(z.string()).optional(),
      locationIds: z.array(z.string()).optional(),
      charterIds: z.array(z.string()).optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!can(ctx, 'items:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const rl = await checkRateLimit(`export-preview:${ctx.userId}`, 120, 60 * 60 * 1000, 'open');
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many preview requests — please wait a moment.' },
        { status: 429 },
      );
    }

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      );
    }
    const { scope, itemType, ids } = parsed.data;
    if (scope === 'selected' && (!ids || ids.length === 0)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Select at least one item to preview.' },
        { status: 400 },
      );
    }

    const filters: InventoryExportFilters | undefined =
      scope === 'filtered'
        ? {
            q: parsed.data.filters?.q,
            status: parsed.data.filters?.status,
            stock: parsed.data.filters?.stock ?? null,
            expected: parsed.data.filters?.expected,
            sort: parsed.data.filters?.sort as ItemListSort | undefined,
            categoryIds: parsed.data.filters?.categoryIds,
            locationIds: parsed.data.filters?.locationIds,
            charterIds: parsed.data.filters?.charterIds,
            warehouseId: await getActiveWarehouseFilterFor(ctx),
          }
        : undefined;

    const result = await buildInventoryExportSourceRows(ctx, { scope, itemType, ids, filters });

    const withIsbn = result.rows.filter((r) => r.isbn.length > 0).length;
    // Presence only — no signing, no Storage round trip.
    const withImage = await countRowsWithImages(
      ctx,
      result.rows.map((r) => r.id),
    );

    return NextResponse.json(
      {
        total: result.total,
        truncated: result.truncated,
        slug: result.slug,
        // The sample never carries image data: a preview must not mint signed
        // URLs, and the dialog draws a neutral placeholder for the image cell.
        sampleRows: result.rows.slice(0, EXPORT_PREVIEW_LIMIT).map((r) => ({ ...r, image: null })),
        readiness: {
          rows: result.rows.length,
          withIsbn,
          missingIsbn: result.rows.length - withIsbn,
          withImage,
          missingImage: result.rows.length - withImage,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'inventory.export.preview' });
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
