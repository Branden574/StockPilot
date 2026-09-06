import { unstable_rethrow } from 'next/navigation';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { csvFilename, toCsv } from '@/lib/csv';
import { reportError } from '@/lib/error-reporter';
import {
  buildInventoryExportRows,
  type InventoryExportFilters,
} from '@/lib/inventory-export';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import { ServiceError } from '@/server/services/context';
import { type ItemListSort } from '@/server/services/inventory';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Large-org CSV export can stream many thousands of rows. (api/inventory is not
// under a vercel.json functions glob, so set the budget inline.)
export const maxDuration = 60;

const ROW_CAP = 10_000;

const VALID_SORTS = new Set<ItemListSort>([
  'updated_desc',
  'updated_asc',
  'name_asc',
  'name_desc',
  'sku_asc',
  'sku_desc',
  'qty_desc',
  'qty_asc',
  'created_desc',
  'created_asc',
]);

// SP-119b: a browser gets its warehouse from the dashboard selector cookie,
// but a non-browser caller (the AI `exportInventory` tool, a bookmarked link,
// a script) has no cookie to set — so a caller that had narrowed its own count
// to one warehouse could only link a CSV covering the whole org, labelling an
// all-warehouse file "413 items". An explicit `?warehouseId=` closes that gap.
// This is a VIEW filter only: it can narrow but never widen, because
// InventoryService.list() forces warehouse-scoped users onto their assigned
// warehouses regardless of what the query string says, and RLS keeps the org
// boundary. Validated as a uuid so a typo REFUSES (400) instead of silently
// degrading to "every warehouse" — a silent fallback here is the same lie the
// finding was about.
const warehouseIdSchema = z.string().uuid();

const VALID_STATUS = new Set(['active', 'archived', 'discontinued', 'all']);
const VALID_TYPES = new Set(['product', 'book', 'asset', 'consumable', 'all']);

// CSV formula-injection escaping happens inside toCsv() now. Every
// string cell across every CSV export gets the guard automatically;
// callers no longer need to remember.

export async function GET(request: Request) {
  try {
    const ctx = await withApiContext(request);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (!can(ctx, 'items:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const url = new URL(request.url);
    const params = url.searchParams;

    // Absent OR empty means "no explicit filter" (fall back to the cookie);
    // present-but-malformed is an error, never a silent whole-org export.
    const rawWarehouseId = params.get('warehouseId')?.trim() || null;
    if (rawWarehouseId !== null && !warehouseIdSchema.safeParse(rawWarehouseId).success) {
      return NextResponse.json({ error: 'invalid_warehouse_id' }, { status: 400 });
    }

    const scope = params.get('scope') === 'all' ? 'all' : 'filtered';
    const rawType = params.get('type') ?? '';
    const itemType = (
      VALID_TYPES.has(rawType) ? rawType : 'all'
    ) as 'product' | 'book' | 'asset' | 'consumable' | 'all';

    // For scope=all we ignore q/status/stock/sort/cat/loc, but we keep
    // itemType so the books-tab "Export all" doesn't dump products.
    const filters: InventoryExportFilters | undefined =
      scope === 'filtered'
        ? {
            q: params.get('q') ?? undefined,
            status: VALID_STATUS.has(params.get('status') ?? '')
              ? (params.get('status') as 'active' | 'archived' | 'discontinued' | 'all')
              : 'active',
            stock:
              params.get('stock') === 'low'
                ? 'low'
                : params.get('stock') === 'out'
                  ? 'out'
                  : null,
            // Mig 0277: forward the page's ?expected=1 so exporting the
            // Expected chip view exports the flagged rows it shows.
            expected: params.get('expected') === '1',
            sort: VALID_SORTS.has(params.get('sort') as ItemListSort)
              ? (params.get('sort') as ItemListSort)
              : 'updated_desc',
            categoryIds: params.getAll('cat').filter(Boolean),
            locationIds: params.getAll('loc').filter(Boolean),
            // Explicit param wins; otherwise the dashboard selector cookie
            // (Bearer/tool callers carry no cookies, so that resolves null).
            warehouseId: rawWarehouseId ?? (await getActiveWarehouseFilterFor(ctx)),
          }
        : undefined;

    const result = await buildInventoryExportRows(ctx, { scope, itemType, filters });

    let body = toCsv([...result.headers], result.rows);

    // Sentinel row when the cap clipped the result — user can re-export
    // with narrower filters to get the rest.
    if (result.truncated) {
      body += `\n# truncated at ${ROW_CAP} rows of ${result.total}`;
    }

    const slug = result.slug;
    const suffix = scope === 'all' ? 'all' : 'filtered';
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(slug, suffix)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    // redirect()/notFound() throw marker errors — hand them back to Next
    // so a signed-out session gets its 307 to /signin instead of a JSON
    // 500 (and no false alert).
    unstable_rethrow(e);
    // ServiceError carries user-facing strings the service author
    // controls — those are fine to surface. Anything else gets
    // funneled into the error reporter; the client only sees a
    // stable slug so DB internals don't leak.
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'inventory.export-csv' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
