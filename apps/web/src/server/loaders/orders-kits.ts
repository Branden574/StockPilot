import 'server-only';

import type { KitComponent, KitOffer, KitsResult } from '@/components/orders/storefront/storefront-kits';
import type { CatalogItem } from '@/components/orders/v2/types';
import { getModulesForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from '@/server/services/lib/paginate';

import type { ModuleId } from '@stockpilot/core';

/**
 * The kits the New order page offers: bundles (Bundles module) whose items this
 * person can order at this warehouse, streamed with the page like the
 * "Frequently ordered" strip (orders-frequently-ordered.ts). Started in
 * orders/new/page.tsx next to the catalog and NEVER awaited there: the shell
 * and the grid never wait for it.
 *
 * WHO SEES A KIT (owner decisions 2026-09-27). Anyone who can place orders
 * (the page already requires orders:request); no Bundles permission is needed,
 * but the Bundles module must be on. A kit is offered only when EVERY required
 * component can be ordered by this person here, so category grants and charter
 * scope apply exactly as they do to the item cards, and a kit never names an
 * item the person cannot see.
 *
 * AUTHORIZATION. Bundles and their components are readable by every member of
 * the organization (0140), so they are read with the visitor's OWN session
 * client, and the named item of each component comes through the same read
 * under the visitor's row level security on inventory_items: a row they may not
 * read comes back empty and the kit is not offered. Every row a kit may use is
 * then taken from the visitor's own catalog (the promise the page already
 * started), and the named row's id is sent only when that catalog holds it, so
 * the browser receives no item id it was not already given.
 *
 * A COMPONENT IS ITS SKU AT THIS WAREHOUSE (owner refinement 2026-09-27). The
 * bundle names one row; the component may use every catalog row with that
 * row's SKU and ownership charter, so the DC4 backpack counts 16-B (134) and
 * 18-A (60). The named row does not have to be orderable itself: when it is
 * archived (for example auto-archived after running out) its SKU's other rows
 * still supply the kit. Rows owned by another charter are never mixed into a
 * kit whose row is generic, or the reverse: that stock is earmarked.
 *
 * DROPPED, never offered:
 *  - no required components: the smallest-of calculation over nothing would be
 *    unlimited. It happens while a bundle is being edited, because an edit
 *    deletes every component and inserts the new set (bundles.ts).
 *  - a per-kit quantity that is not a whole number: order lines are whole units.
 *  - a named row that is deleted, in another warehouse, or unreadable, or a SKU
 *    with no orderable row in this person's catalog here.
 * Optional components are not added by the kit (owner decision 5).
 *
 * NEVER REJECTS. A failed read answers `{ status: 'error' }`, which the page
 * shows as "Kits could not be loaded", never as "no kits". The module switched
 * off answers an empty list.
 *
 * NOT CACHED, on purpose: one small read per visit, under the visitor's own
 * row level security, and the catalog it is matched against carries the 60 s
 * stock cache.
 */

interface CatalogForKits {
  items: ReadonlyArray<Pick<CatalogItem, 'id' | 'sku' | 'charterId' | 'rackLabel'>>;
}

interface NamedItemRow {
  id: string;
  sku: string | null;
  warehouse_id: string | null;
  charter_id: string | null;
  deleted_at: string | null;
}

interface BundleRow {
  id: string;
  name: string;
  sku: string | null;
  bundle_components: Array<{
    item_id: string;
    quantity: number | string;
    is_optional: boolean | null;
    item: NamedItemRow | NamedItemRow[] | null;
  }> | null;
}

/** The SKU key a component matches on: the SKU within its ownership charter. */
function skuKey(sku: string, charterId: string | null): string {
  return `${sku}\u0000${charterId ?? ''}`;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Who is asking, for a request whose session is not in cookies (phone ordering
 * PO-3). The phone's Bearer request has no cookie session: getModulesForRequest
 * and the cookie client would answer as an anonymous visitor, so the bundles
 * read came back empty and the page's "no kits" was a silent wrong answer.
 * The route passes its context's own modules and client instead. Left out,
 * both default to what the web page has always used.
 */
export interface OrderKitsCaller {
  /** The organization's enabled modules (ctx.enabledModules). */
  modules?: ReadonlySet<ModuleId>;
  /** The caller's own client (ctx.supabase). */
  client?: Pick<Awaited<ReturnType<typeof createClient>>, 'from'>;
}

export async function loadOrderKits(
  organizationId: string,
  warehouseId: string,
  catalog: Promise<CatalogForKits>,
  caller: OrderKitsCaller = {},
): Promise<KitsResult> {
  try {
    const modules = caller.modules ?? (await getModulesForRequest(organizationId));
    if (!modules.has('bundles')) return { status: 'ok', kits: [] };

    const supabase = caller.client ?? (await createClient());
    const [bundles, { items }] = await Promise.all([
      fetchAllRows<BundleRow>(
        (from, to) =>
          supabase
            .from('bundles')
            .select(
              'id, name, sku, bundle_components(item_id, quantity, is_optional, item:inventory_items(id, sku, warehouse_id, charter_id, deleted_at))',
            )
            .eq('organization_id', organizationId)
            .eq('is_active', true)
            .is('archived_at', null)
            .order('name', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: BundleRow[] | null;
            error: { message: string } | null;
          }>,
      ),
      catalog,
    ]);
    return { status: 'ok', kits: resolveKits(bundles, items, warehouseId) };
  } catch (err) {
    // A SHORT LABEL ONLY: a message can quote request details.
    const why =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'unreadable';
    console.warn('[order-kits] kits could not be loaded:', why);
    return { status: 'error' };
  }
}

/**
 * Bundles to kits for one warehouse, against the visitor's catalog there.
 * Exported for tests; the rules are in the header above.
 */
export function resolveKits(
  bundles: readonly BundleRow[],
  catalogItems: CatalogForKits['items'],
  warehouseId: string,
): KitOffer[] {
  const catalogById = new Map(catalogItems.map((it) => [it.id, it]));
  const rowsBySku = new Map<string, Array<CatalogForKits['items'][number]>>();
  for (const it of catalogItems) {
    if (!it.sku || it.sku.trim() === '') continue;
    const key = skuKey(it.sku, it.charterId);
    const list = rowsBySku.get(key);
    if (list) list.push(it);
    else rowsBySku.set(key, [it]);
  }

  const kits: KitOffer[] = [];
  for (const bundle of bundles) {
    const required = (bundle.bundle_components ?? []).filter((c) => c.is_optional !== true);
    if (required.length === 0) continue;

    const components = new Map<string, KitComponent>();
    let offerable = true;
    for (const c of required) {
      const perKit = Number(c.quantity);
      const named = one(c.item);
      if (
        !Number.isInteger(perKit) ||
        perKit < 1 ||
        !named ||
        named.id !== c.item_id ||
        named.deleted_at !== null ||
        named.warehouse_id !== warehouseId
      ) {
        offerable = false;
        break;
      }
      const sku = named.sku?.trim() ? named.sku : null;
      // A row with no SKU is its own component: nothing else can be matched to it.
      const key = sku ? skuKey(sku, named.charter_id) : `id\u0000${named.id}`;
      const rows = sku
        ? (rowsBySku.get(key) ?? [])
        : catalogById.has(named.id)
          ? [catalogById.get(named.id)!]
          : [];
      if (rows.length === 0) {
        offerable = false;
        break;
      }
      const existing = components.get(key);
      if (existing) {
        // Two components naming rows of one SKU are one component: their
        // per-kit quantities add up, so its stock is never counted twice.
        existing.perKit += perKit;
        continue;
      }
      const ordered = [...rows].sort((a, b) => {
        if (a.id === named.id) return -1;
        if (b.id === named.id) return 1;
        const ra = a.rackLabel ?? '';
        const rb = b.rackLabel ?? '';
        if (ra !== rb) return ra < rb ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      components.set(key, {
        // The named row when this person's catalog holds it. When it does not
        // (archived, or readable but not orderable), its id is NOT sent: the
        // browser only ever receives ids of rows it was already given (review
        // F8), and the SKU's first catalog row stands in as the row a tie
        // prefers.
        anchorItemId: catalogById.has(named.id) ? named.id : ordered[0]!.id,
        itemIds: ordered.map((r) => r.id),
        perKit,
      });
    }
    if (!offerable) continue;
    kits.push({
      bundleId: bundle.id,
      name: bundle.name,
      sku: bundle.sku?.trim() ? bundle.sku : null,
      components: [...components.values()],
    });
  }
  return kits;
}
