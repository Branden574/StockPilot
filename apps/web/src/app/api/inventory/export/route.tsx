import { Readable } from 'node:stream';

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { toCsv } from '@/lib/csv';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import {
  buildInventoryExportRows,
  type InventoryExportFilters,
} from '@/lib/inventory-export';
import { toInventoryXlsx } from '@/lib/inventory-export-xlsx';
import { ReportTablePdf } from '@/lib/pdf/report-table';
import { BOOKS_PDF_COLUMNS, ITEMS_PDF_COLUMNS } from '@/lib/pdf/inventory-pdf-columns';
import { ServiceError } from '@/server/services/context';
import type { ItemListSort } from '@/server/services/inventory';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Large-org CSV/Excel/PDF export can take a while. (api/inventory is not under a
// vercel.json functions glob, so set the budget inline.)
export const maxDuration = 60;

// Unified inventory export: any scope (selected / filtered / all) × any format
// (csv / xlsx / pdf). POST (not GET) so a large "export selected" id list isn't
// capped by URL length. Shares the fail-closed row builder with the legacy
// /export.csv route.
const bodySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  scope: z.enum(['selected', 'filtered', 'all']),
  itemType: z.enum(['product', 'book', 'asset', 'consumable', 'all']).default('all'),
  ids: z.array(z.string().uuid()).max(10_000).optional(),
  filters: z
    .object({
      q: z.string().optional(),
      status: z.enum(['active', 'archived', 'discontinued', 'all']).optional(),
      stock: z.enum(['low', 'out']).nullable().optional(),
      // Mig 0277: true = the page's Expected chip view — export ONLY items
      // awaiting their first receipt (matching the visible rows).
      expected: z.boolean().optional(),
      sort: z.string().optional(),
      categoryIds: z.array(z.string()).optional(),
      locationIds: z.array(z.string()).optional(),
      charterIds: z.array(z.string()).optional(),
    })
    .optional(),
});

function exportFilename(slug: string, scope: string, ext: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${slug}-${scope}-${date}.${ext}`;
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!can(ctx, 'items:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // Compute-heavy (up to 10k rows -> in-memory xlsx/pdf render). Cap like
    // every other export route so one account can't sustain a serverless-cost
    // DoS; this also emits the security.export_rate_limited audit event.
    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      );
    }
    const { format, scope, itemType, ids } = parsed.data;
    if (scope === 'selected' && (!ids || ids.length === 0)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Select at least one item to export.' },
        { status: 400 },
      );
    }

    // For scope=filtered, honor the active-warehouse cookie just like the
    // legacy route (the UI passes the rest of the visible filters).
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

    const result = await buildInventoryExportRows(ctx, { scope, itemType, ids, filters });

    // ── CSV ──────────────────────────────────────────────────────────
    if (format === 'csv') {
      let body = toCsv(result.headers, result.rows);
      if (result.truncated) body += `\n# truncated at 10000 rows of ${result.total}`;
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${exportFilename(result.slug, scope, 'csv')}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // ── Excel (.xlsx) ────────────────────────────────────────────────
    if (format === 'xlsx') {
      const buf = await toInventoryXlsx(result.headers, result.rows);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${exportFilename(result.slug, scope, 'xlsx')}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // ── PDF ──────────────────────────────────────────────────────────
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const titleNoun = result.slug === 'books' ? 'Books' : 'Inventory';
    const stream = await renderToStream(
      // eslint-disable-next-line react-hooks/error-boundaries -- RSC + react-pdf renderToStream; rule targets client error boundaries
      <ReportTablePdf
        orgName={orgName}
        orgLogoUrl={orgLogoUrl}
        title={`${titleNoun} export`}
        subtitle={`${scope} · ${result.rows.length} item${result.rows.length === 1 ? '' : 's'}${result.truncated ? ` (first 10000 of ${result.total})` : ''}`}
        sections={[
          {
            columns: result.slug === 'books' ? BOOKS_PDF_COLUMNS : ITEMS_PDF_COLUMNS,
            rows: result.rows.map((r) => ({ cells: r })),
          },
        ]}
      />,
    );
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${exportFilename(result.slug, scope, 'pdf')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'inventory.export' });
    // Surface the actual message (not just an opaque "internal_error") so a
    // failed export is diagnosable from the toast instead of silently generic.
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
