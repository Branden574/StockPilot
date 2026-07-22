import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { requireOrgContext } from '@/lib/auth/session';
import { isAdminRole } from '@stockpilot/core';
import {
  loadInventoryLookups,
  loadInventoryTrendBuckets,
} from '@/server/loaders/inventory-list';
import { InventoryService } from '@/server/services/inventory';
import { withContext } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * TEMPORARY perf diagnostic (2026-07-22). Times each server-side stage the
 * Items page performs so we can rank what actually costs the ~600ms between
 * TTFB (38ms) and the fully-streamed document — headers can't be set after a
 * Server Component starts streaming, so a Server-Timing header isn't possible;
 * this route runs the SAME stages and reports their durations as JSON.
 *
 * Admin-gated and read-only. Delete once the optimization work lands.
 */
async function time<T>(
  label: string,
  fn: () => Promise<T>,
  into: Record<string, number>,
): Promise<T | null> {
  const t0 = performance.now();
  try {
    return await fn();
  } catch {
    return null;
  } finally {
    into[label] = Math.round((performance.now() - t0) * 10) / 10;
  }
}

export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!isAdminRole(ctx.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const sequential: Record<string, number> = {};
  const parallel: Record<string, number> = {};
  const wall0 = performance.now();

  // ── The per-request auth/context chain (runs on EVERY page) ──────────────
  await time('1_requireOrgContext', () => requireOrgContext(), sequential);
  await time('2_withContext', () => withContext(), sequential);

  const svc = new InventoryService(ctx);

  // ── The Items page's data stages, timed individually but run in parallel
  //    exactly like the page does (so the numbers reflect real contention) ──
  const pStart = performance.now();
  await Promise.all([
    time(
      'list_rows_30',
      () => svc.list({ itemType: 'product', limit: 30, offset: 0 }),
      parallel,
    ),
    time('count_expected', () => svc.countExpected({ itemType: 'product' }), parallel),
    time('cached_lookups', () => loadInventoryLookups(ctx.organizationId), parallel),
    time('cached_trends', () => loadInventoryTrendBuckets(ctx.organizationId), parallel),
  ]);
  const parallelWall = Math.round((performance.now() - pStart) * 10) / 10;

  const totalWall = Math.round((performance.now() - wall0) * 10) / 10;
  const authChain = (sequential['1_requireOrgContext'] ?? 0) + (sequential['2_withContext'] ?? 0);

  return NextResponse.json(
    {
      ok: true,
      totalWallMs: totalWall,
      authChainMs: Math.round(authChain * 10) / 10,
      dataParallelWallMs: parallelWall,
      sequential,
      parallel,
      note: 'authChain runs before ANY page data and is pure per-request overhead',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
