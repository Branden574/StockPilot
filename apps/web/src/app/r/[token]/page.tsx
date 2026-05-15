import { notFound } from 'next/navigation';

import { PublicOrderForm } from '@/components/orders/public-order-form';
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

interface BookSummary {
  id: string;
  name: string;
  author: string | null;
  quantityOnHand: number;
  imageUrl: string | null;
}

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
  const books = await loadBooks(admin, org.id, activeWarehouse.id);

  return (
    <div>
      <Header org={org} />
      <PublicOrderForm
        token={token}
        orgName={org.name}
        warehouses={warehouses}
        initialWarehouseId={activeWarehouse.id}
        initialBooks={books}
      />
      <p className="text-muted-foreground mt-10 text-center text-xs">
        <a className="underline" href="/r/track">
          Track an order you&apos;ve already submitted
        </a>
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

async function loadBooks(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  warehouseId: string,
): Promise<BookSummary[]> {
  const { data: items } = await admin
    .from('inventory_items')
    .select('id, name, custom_fields, quantity_on_hand')
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
    custom_fields: Record<string, unknown> | null;
    quantity_on_hand: number | string | null;
  };
  const rows = (items ?? []) as ItemRow[];
  if (rows.length === 0) return [];

  const itemIds = rows.map((r) => r.id);

  // Pull primary item images for these books in one round trip + one
  // signed-URL batch call, mirroring ItemImagesService.primaryImagesForItems.
  const { data: imgRows } = await admin
    .from('item_images')
    .select('item_id, storage_path, is_primary, sort_order')
    .in('item_id', itemIds)
    .order('is_primary', { ascending: false })
    .order('sort_order', { ascending: true });
  const pathByItem = new Map<string, string>();
  for (const r of (imgRows ?? []) as Array<{ item_id: string; storage_path: string }>) {
    if (!pathByItem.has(r.item_id)) pathByItem.set(r.item_id, r.storage_path);
  }
  const urlByPath = new Map<string, string>();
  if (pathByItem.size > 0) {
    // F6: 1-hour TTL. This page is force-dynamic so signed URLs are
    // re-minted on every load — no SSG cache benefits from a long TTL.
    // The previous 7-day window meant browsable item-image links
    // lingered in mailbox previews and screenshots for a week past
    // the actual session.
    const { data: signed } = await admin.storage
      .from('item-images')
      .createSignedUrls([...pathByItem.values()], 60 * 60);
    for (const entry of signed ?? []) {
      if (entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl);
    }
  }

  return rows.map((r) => {
    const cf = (r.custom_fields ?? {}) as Record<string, unknown>;
    const author = typeof cf.author === 'string' ? cf.author : null;
    const thumb =
      typeof cf.thumbnail_url === 'string' && cf.thumbnail_url.length > 0
        ? cf.thumbnail_url
        : null;
    const path = pathByItem.get(r.id);
    const uploadedUrl = path ? urlByPath.get(path) ?? null : null;
    return {
      id: r.id,
      name: r.name,
      author,
      quantityOnHand: Number(r.quantity_on_hand) || 0,
      imageUrl: uploadedUrl ?? thumb,
    } satisfies BookSummary;
  });
}
