import { unstable_cache } from 'next/cache';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PublicOrdersV2 } from '@/components/orders/public-v2/public-orders-v2';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPublicBookCatalog } from '@/server/services/public-catalog';

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
 * Cached resolver: token → minimal org row. Called from both
 * generateMetadata AND the page render in the same request — caching
 * dedupes both within one render AND lets repeat visits within 60s
 * skip the Supabase round-trip entirely.
 *
 * Stale window for an org name/logo/blurb is acceptable; renames and
 * blurb edits are extremely rare and 60s drift on a public landing
 * page is invisible. If a token is rotated/revoked, the prior owner
 * could see stale rendering for up to 60s — but the order-submit
 * endpoint validates the token fresh on POST, so submissions still
 * fail closed even if the page renders stale.
 */
const getOrgByPublicToken = unstable_cache(
  async (token: string) => {
    const admin = createAdminClient();
    const { data } = await admin
      .from('organizations')
      .select('id, name, logo_url, public_request_blurb')
      .eq('public_request_token', token)
      .maybeSingle();
    return data as
      | { id: string; name: string; logo_url: string | null; public_request_blurb: string | null }
      | null;
  },
  ['public-org-by-token-v1'],
  { revalidate: 60, tags: ['public-org-by-token'] },
);

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
  const orgRow = await getOrgByPublicToken(token);
  const orgName = orgRow?.name ?? 'Order request';
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

  // 1. Resolve the org. 404 silently if the token is unknown. Shared
  // cached lookup with generateMetadata above — same DB row, one fetch.
  const org = await getOrgByPublicToken(token);
  if (!org) notFound();
  const admin = createAdminClient();

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
  const items = await getPublicBookCatalog(org.id, activeWarehouse.id);
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
      <Header org={org} warehouseName={activeWarehouse.name} catalogCount={items.length} />
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
  warehouseName,
  catalogCount,
}: {
  org: { name: string; logo_url: string | null; public_request_blurb: string | null };
  warehouseName?: string;
  catalogCount?: number;
}) {
  return (
    <header className="mb-8">
      {/* Brand row */}
      <div className="border-border flex items-center gap-3 border-b pb-5">
        {isAllowedLogoUrl(org.logo_url) ? (
          <Image
            src={org.logo_url}
            alt={`${org.name} logo`}
            width={40}
            height={40}
            priority
            sizes="40px"
            className="h-10 w-10 rounded-lg object-cover"
          />
        ) : (
          <div className="bg-foreground text-background font-display grid h-10 w-10 place-items-center rounded-lg text-sm font-semibold">
            {org.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <div className="font-display text-[15px] font-semibold leading-tight tracking-[-0.02em]">
            {org.name}
          </div>
          <div className="text-muted-foreground mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em]">
            Supply Requests
          </div>
        </div>
        <span className="text-muted-foreground ml-auto hidden text-[11px] sm:inline">
          Powered by StockPilot
        </span>
      </div>

      {/* Intro */}
      <div className="mt-7 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0 flex-1">
          <div className="text-primary mb-3 font-mono text-[11px] uppercase tracking-[0.18em]">
            Place an order
          </div>
          <h1 className="font-display max-w-[16ch] text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-[38px]">
            Request books &amp;{' '}
            <span className="text-muted-foreground italic">classroom supplies.</span>
          </h1>
          {org.public_request_blurb ? (
            // Blurb may contain markdown; rendered as plain text with line
            // breaks preserved.
            <p className="text-muted-foreground mt-4 max-w-[52ch] whitespace-pre-line text-sm leading-relaxed">
              {org.public_request_blurb}
            </p>
          ) : (
            <p className="text-muted-foreground mt-4 max-w-[52ch] text-sm leading-relaxed">
              Browse the catalog, add what your campus needs, and tell us how to get
              it to you. Our team reviews every request before stock is pulled —
              you&apos;ll get an email confirmation once it&apos;s approved.
            </p>
          )}
        </div>

        {warehouseName && typeof catalogCount === 'number' ? (
          <dl className="flex shrink-0 flex-col gap-2.5 text-[12.5px]">
            <div className="flex items-center gap-2.5">
              <dt className="text-muted-foreground w-24 font-mono text-[10px] uppercase tracking-[0.14em]">
                Warehouse
              </dt>
              <dd className="text-foreground/90 flex items-center gap-2">
                <span className="bg-primary h-1.5 w-1.5 rounded-full" />
                {warehouseName}
              </dd>
            </div>
            <div className="flex items-center gap-2.5">
              <dt className="text-muted-foreground w-24 font-mono text-[10px] uppercase tracking-[0.14em]">
                Catalog
              </dt>
              <dd className="text-foreground/90">{catalogCount} items in stock</dd>
            </div>
            <div className="flex items-center gap-2.5">
              <dt className="text-muted-foreground w-24 font-mono text-[10px] uppercase tracking-[0.14em]">
                Turnaround
              </dt>
              <dd className="text-foreground/90">Reviewed within 1 business day</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </header>
  );
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
