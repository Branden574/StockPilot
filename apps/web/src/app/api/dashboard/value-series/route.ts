import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import {
  getDashboardValueComparison,
  type ValueBasis,
  type ValueComparisonMode,
} from '@/server/services/movements';

import { isManagerOrAbove } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODES: ValueComparisonMode[] = ['previous', 'locations', 'retail_vs_cost'];
const BASES: ValueBasis[] = ['cost', 'retail'];

/**
 * On-demand series for the dashboard "Inventory value" card's Compare menu +
 * basis toggle. Fired only when the user interacts — the default 30d cost line
 * is still SSR'd from the page loader, so this route never touches the eager
 * dashboard render path.
 *
 *   GET ?mode=&basis=&days=&warehouseId=
 *
 * AUTH: session/bearer via withApiContext → 401 when unresolved. GATE: manager+
 * (isManagerOrAbove) — the same population that may read org-wide valuation
 * (org_daily_stats is manager+-only, 0230); the value card is org-wide value
 * data, so a warehouse/category-restricted member must not pull it here. SCOPE:
 * the loader reads via ctx.supabase (user-authed, RLS applies) with an explicit
 * organization_id filter inside dashboard_value_series — never admin/service.
 */
export async function GET(request: Request) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (!isManagerOrAbove(ctx.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // Cheap throttle: this fans out several reconstructed-path RPCs per call.
    // Fails OPEN (auth'd surface) so a transient DB blip won't stonewall.
    const rl = await checkRateLimit(`dashboard-value-series:${ctx.userId}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }

    const params = new URL(request.url).searchParams;

    const daysRaw = params.get('days');
    const days = daysRaw === '30' ? 30 : daysRaw === '90' ? 90 : null;
    if (days === null) {
      return NextResponse.json(
        { error: 'validation_error', message: 'days must be 30 or 90' },
        { status: 400 },
      );
    }

    const basisRaw = params.get('basis') ?? 'cost';
    if (!BASES.includes(basisRaw as ValueBasis)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'basis must be cost or retail' },
        { status: 400 },
      );
    }
    const basis = basisRaw as ValueBasis;

    const modeRaw = params.get('mode');
    if (!modeRaw || !MODES.includes(modeRaw as ValueComparisonMode)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'mode must be previous, locations, or retail_vs_cost' },
        { status: 400 },
      );
    }
    const mode = modeRaw as ValueComparisonMode;

    // Optional warehouse narrowing. A forged/garbage id must not reach the RPC
    // (RLS would zero it out, but reject early for a clean 400). Ignored by the
    // 'locations' mode, which iterates the caller's own warehouses.
    const warehouseParam = params.get('warehouseId');
    if (warehouseParam && !UUID_RE.test(warehouseParam)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'warehouseId must be a uuid' },
        { status: 400 },
      );
    }
    const warehouseId = warehouseParam || undefined;

    const result = await getDashboardValueComparison({
      ctx,
      warehouseId,
      days,
      basis,
      mode,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
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
    void reportError(e, { tag: 'dashboard.value-series' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
