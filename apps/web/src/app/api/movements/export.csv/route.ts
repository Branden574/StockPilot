import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { csvFilename, toCsv } from '@/lib/csv';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import {
  parseFromDateParam,
  parseMovementTypeParam,
  parseToDateParam,
} from '@/lib/movements-filters';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { ServiceError } from '@/server/services/context';
import { MovementsService } from '@/server/services/movements';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROW_CAP = 10_000;

const HEADERS = [
  'date',
  'item_sku',
  'item_name',
  'movement_type',
  'quantity_change',
  'previous_quantity',
  'new_quantity',
  'from_location',
  'to_location',
  'reference_type',
  'reference_id',
  'reason',
  'notes',
  'actor_email',
] as const;

export async function GET(request: Request) {
  try {
    const ctx = await withApiContext(request);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    // Same gate as the Movements page (requireOrgContext + can(...) there) —
    // a viewer/staff member who can't see the org-wide ledger on screen must
    // not be able to pull it via export either. Org-scope + RLS are
    // additionally enforced inside MovementsService via the user-authed
    // client + explicit organization_id filter (never admin/service-role).
    if (!can(ctx, 'activity_logs:read')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const search = params.get('q') ?? undefined;
    const type = parseMovementTypeParam(params.get('type'));
    const since = parseFromDateParam(params.get('from'));
    const until = parseToDateParam(params.get('to'));
    // Same warehouse-filter cookie the page reads via getActiveWarehouseFilter
    // — resolved server-side so the export can't be pointed at a warehouse
    // the caller doesn't have via a forged query param.
    const warehouseId = (await getActiveWarehouseFilter()) ?? undefined;

    const { rows, total } = await new MovementsService(ctx).exportRows({
      warehouseId,
      search,
      types: type ? [type] : undefined,
      since,
      until,
      cap: ROW_CAP,
    });

    const csvRows = rows.map((r) => ({
      date: r.createdAt,
      item_sku: r.itemSku ?? '',
      item_name: r.itemName ?? '',
      movement_type: r.movementType,
      quantity_change: r.quantityChange,
      previous_quantity: r.previousQuantity,
      new_quantity: r.newQuantity,
      from_location: r.fromLocation ?? '',
      to_location: r.toLocation ?? '',
      reference_type: r.referenceType ?? '',
      reference_id: r.referenceId ?? '',
      reason: r.reason ?? '',
      notes: r.notes ?? '',
      actor_email: r.actorEmail ?? '',
    }));

    let body = toCsv([...HEADERS], csvRows);
    // Report what was ACTUALLY returned, not the intended ROW_CAP — mirrors
    // orders/export.csv's truncation sentinel.
    if (total > rows.length) {
      body += `\n# truncated: exported ${rows.length} of ${total} rows`;
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('movements')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'module_disabled' || e.code === 'forbidden'
          ? 403
          : e.code === 'validation_error'
            ? 400
            : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    void reportError(e, { tag: 'movements.export-csv' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
