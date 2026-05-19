import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PublicOrdersV2 } from '@/components/orders/public-v2/public-orders-v2';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * F9: org.logo_url is editable by org admins and could in theory hold
 * any URL — including an off-site image used for tracking pixel attacks
 * against everyone who scans the public order link. Lock the rendered
 * logo to our Supabase storage public bucket. If the stored value
 * doesn't match the allowlist (legacy data, manual edit), render no
 * image rather than throwing — the page itself still works fine
 * without a logo.
 */
function isAllowedLogoUrl(value: string | null): value is string {
  if (!value) return false;
  const allowedPrefix = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/org-logos/`;
  return value.startsWith(allowedPrefix);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public order-request landing page.
 *
 * URL: `/r/<token>` — anyone with the link lands here. Anonymous, no
 * auth required. Uses the service-role admin client because the visitor
 * has no Supabase JWT; the token IS the auth.
 *
 * Renders:
 *   - Org branding (name, logo, blurb)
 *   - Warehouse picker (only if more than one is publicly orderable)
 *   - Book grid filtered to the chosen warehouse
 *   - The submit form (`<PublicOrderForm />`)
 *
 * If zero warehouses are flagged `is_public_orderable` we show a
 * friendly "not currently accepting requests" card instead of a broken
 * empty form.
 */

interface WarehouseSummary {
  id: string;
  name: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const admin = createAdminClient();
  const { data } = await admin
    .from('organizations')
    .select('name')
    .eq('public_request_token', token)
    .maybeSingle();
  const orgName = (data as { name?: string } | null)?.name ?? 'Order request';
  return {
    title: `${orgName} · Place an order`,
    robots: { index: false, follow: false },
  };
}

export default async function PublicOrderRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!token || token.length < 16) notFound();
  const sp = await searchParams;
  const warehouseQuery = Array.isArray(sp.w) ? sp.w[0] : sp.w;

  const admin = createAdminClient();

  // 1. Resolve the org. 404 silently if the token is unknown.
  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name, logo_url, public_request_blurb')
    .eq('public_request_token', token)
    .maybeSingle();
  if (!orgRow) notFound();
  const org = orgRow as {
    id: string;
    name: string;
    logo_url: string | null;
    public_request_blurb: string | null;
  };

  // 2. Eligible warehouses.
  const { data: whRows } = await admin
    .from('warehouses')
    .select('id, name')
    .eq('organization_id', org.id)
    .eq('is_public_orderable', true)
    .order('name', { ascending: true });
  const warehouses: WarehouseSummary[] = ((whRows ?? []) as Array<{
    id: string;
    name: string;
  }>).map((w) => ({ id: w.id, name: w.name }));

  // No eligible warehouses → render the friendly "closed" card.
  if (warehouses.length === 0) {
    return (
      <div className="mx-auto max-w-md py-10">
        <Header org={org} />
        <div className="border-border bg-card mt-8 rounded-2xl border p-6 text-center">
          <h2 className="font-display text-lg">Not accepting requests</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            This organization isn&apos;t currently accepting public order
            requests. Please check back later or reach out to them
            directly.
          </p>
        </div>
      </div>
    );
  }

  // Pick the active warehouse: prefer ?w= if it's still eligible, else the
  // first one alphabetically. This keeps the warehouse switcher reload-safe.
  const requested = warehouseQuery
    ? warehouses.find((w) => w.id === warehouseQuery) ?? null
    : null;
  const activeWarehouse = requested ?? warehouses[0];
  if (!activeWarehouse) notFound();
  const items = await loadBookCatalog(admin, org.id, activeWarehouse.id);
  const aisles = buildAisles(items);

  // Charters serviced by the active warehouse — restricted to status=
  // 'active' so the dropdown never shows archived/inactive sites. The
  // warehouse switcher does a hard reload, so this list refreshes for
  // free on warehouse change (no client-side refetch needed).
  const { data: charterPairs } = await admin
    .from('warehouse_charters')
    .select('charter:charters!inner (id, name, code, status)')
    .eq('warehouse_id', activeWarehouse.id);
  const chartersForWarehouse = (charterPairs ?? [])
    .map((p) => {
      const c = Array.isArray((p as { charter?: unknown }).charter)
        ? ((p as { charter: unknown[] }).charter[0] as Record<string, unknown>)
        : ((p as { charter: unknown }).charter as Record<string, unknown> | null);
      return c
        ? {
            id: c.id as string,
            name: c.name as string,
            code: (c.code as string | null) ?? null,
            status: c.status as string,
          }
        : null;
    })
    .filter(
      (c): c is { id: string; name: string; code: string | null; status: string } =>
        c !== null && c.status === 'active',
    )
    .map(({ id, name, code }) => ({ id, name, code }));

  return (
    <div>
      <Header org={org} />
      <PublicOrdersV2
        token={token}
        orgName={org.name}
        warehouses={warehouses}
        initialWarehouseId={activeWarehouse.id}
        items={items}
        aisles={aisles}
        chartersForWarehouse={chartersForWarehouse}
      />
      <p className="text-muted-foreground mt-10 text-center text-xs">
        <Link className="underline" href="/r/track">
          Track an order you&apos;ve already submitted
        </Link>
      </p>
    </div>
  );
}

function Header({
  org,
}: {
  org: { name: string; logo_url: string | null; public_request_blurb: string | null };
}) {
  return (
    <header className="mb-6 flex flex-col items-center text-center">
      {isAllowedLogoUrl(org.logo_url) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={org.logo_url}
          alt=""
          className="mb-4 h-12 w-12 rounded-lg object-cover"
        />
      ) : null}
      <h1 className="font-display text-[28px] font-medium leading-tight tracking-[-0.025em]">
        {org.name}
      </h1>
      <p className="text-muted-foreground mt-1 text-[11px] font-medium uppercase tracking-[0.12em]">
        Place an order
      </p>
      {org.public_request_blurb ? (
        // Markdown is allowed in the blurb but rendered as plain text
        // here. Whitespace + line breaks are preserved via whitespace-pre-line.
        <p className="text-muted-foreground mt-4 max-w-prose whitespace-pre-line text-sm leading-relaxed">
          {org.public_request_blurb}
        </p>
      ) : null}
    </header>
  );
}

/**
 * Loads the books-only catalog for the public order link, returning
 * CatalogItem[] compatible with the v2 picker components. Mirrors the
 * staff-side loadCatalogItemsUncached but filtered to item_type='book'
 * and token-gated (caller has already validated org + warehouse).
 *
 * imageUrl is returned as null — client fetches deferred thumbnails via
 * /api/v1/public/catalog-thumbnails after first paint. LQIP blurs are
 * inlined so cards never flash a stark placeholder.
 */
async function loadBookCatalog(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  warehouseId: string,
): Promise<CatalogItem[]> {
  const { data: itemsData } = await admin
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, warehouse_id, item_type, custom_fields, bin_location, category_id, retail_price, unit_cost, reorder_point',
    )
    .eq('organization_id', orgId)
    .eq('warehouse_id', warehouseId)
    .eq('item_type', 'book')
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .limit(500);

  type ItemRow = {
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number | null;
    warehouse_id: string;
    item_type: string | null;
    custom_fields: Record<string, unknown> | null;
    bin_location: string | null;
    category_id: string | null;
    retail_price: number | null;
    unit_cost: number | null;
    reorder_point: number | null;
  };

  const items = (itemsData ?? []) as ItemRow[];
  if (items.length === 0) return [];

  const itemIds = items.map((i) => i.id);
  const categoryIds = [
    ...new Set(
      items.map((i) => i.category_id).filter((v): v is string => Boolean(v)),
    ),
  ];

  // Reservations + category names + LQIP blurs in parallel.
  // Signed thumbnail URLs are deferred to the client (same pattern as staff).
  const [rsRes, categoriesRes, lqipRes] = await Promise.all([
    admin
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', orgId)
      .in('item_id', itemIds)
      .is('released_at', null),
    categoryIds.length > 0
      ? admin
          .from('categories')
          .select('id, name')
          .eq('organization_id', orgId)
          .in('id', categoryIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    admin
      .from('item_images')
      .select('item_id, lqip, is_primary, sort_order')
      .eq('organization_id', orgId)
      .in('item_id', itemIds)
      .not('lqip', 'is', null)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true }),
  ]);

  const reservedByItem = new Map<string, number>();
  for (const row of (rsRes.data ?? []) as Array<{
    item_id: string;
    quantity: number;
  }>) {
    reservedByItem.set(
      row.item_id,
      (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity),
    );
  }

  const categoryNameById = new Map<string, string>();
  for (const c of (categoriesRes.data ?? []) as Array<{
    id: string;
    name: string;
  }>) {
    categoryNameById.set(c.id, c.name);
  }

  const lqipByItem = new Map<string, string>();
  for (const row of (lqipRes.data ?? []) as Array<{
    item_id: string;
    lqip: string | null;
  }>) {
    if (!lqipByItem.has(row.item_id) && row.lqip) {
      lqipByItem.set(row.item_id, row.lqip);
    }
  }

  function rackLabelFor(it: ItemRow): string | null {
    if (it.bin_location && it.bin_location.trim()) return it.bin_location.trim();
    const cf = it.custom_fields ?? {};
    const num = (cf as { book_rack_number?: unknown }).book_rack_number as
      | string
      | undefined;
    const row = (cf as { book_rack_row?: unknown }).book_rack_row as
      | string
      | undefined;
    if (!num) return null;
    return row ? `${num}-${row}` : String(num);
  }

  return items.map((it) => ({
    id: it.id,
    sku: it.sku,
    name: it.name,
    warehouseId: it.warehouse_id,
    quantityOnHand: Number(it.quantity_on_hand) || 0,
    reservedQuantity: reservedByItem.get(it.id) ?? 0,
    itemType: it.item_type ?? null,
    categoryId: it.category_id ?? null,
    categoryName: it.category_id ? (categoryNameById.get(it.category_id) ?? null) : null,
    rackLabel: rackLabelFor(it),
    imageUrl: null,
    lqip: lqipByItem.get(it.id) ?? null,
    price:
      typeof it.retail_price === 'number'
        ? it.retail_price
        : typeof it.unit_cost === 'number'
        ? it.unit_cost
        : null,
    reorderPoint: Number(it.reorder_point) || 0,
  })) satisfies CatalogItem[];
}

/**
 * Derives the aisle summary list from the loaded catalog items.
 * Named aisles are sorted alphabetically; the synthetic "Uncategorized"
 * bucket appears last if any items have no category.
 */
function buildAisles(items: CatalogItem[]): AisleSummary[] {
  const countById = new Map<string, number>();
  let uncategorizedCount = 0;
  const nameById = new Map<string, string>();

  for (const it of items) {
    if (it.categoryId === null) {
      uncategorizedCount++;
    } else {
      countById.set(it.categoryId, (countById.get(it.categoryId) ?? 0) + 1);
      if (it.categoryName) nameById.set(it.categoryId, it.categoryName);
    }
  }

  const named: AisleSummary[] = Array.from(countById.entries())
    .map(([id, itemCount]) => ({
      id,
      name: nameById.get(id) ?? id,
      itemCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (uncategorizedCount > 0) {
    named.push({ id: null, name: 'Uncategorized', itemCount: uncategorizedCount });
  }

  return named;
}
