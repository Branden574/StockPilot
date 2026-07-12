import { Ban } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { PublicOrdersV2 } from '@/components/orders/public-v2/public-orders-v2';
import type { PublicCatalogItem } from '@/components/orders/public-v2/types';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  getPublicCatalogForLink,
  isLinkOpen,
  resolvePublicRequestToken,
} from '@/server/services/public-catalog';

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
 * Since migration 0261 a token resolves to a public_request_links row
 * FIRST (each org's legacy token was migrated onto its "General request
 * link", so existing URLs keep working), with the old
 * organizations.public_request_token lookup as a fallback. The link row
 * decides what this page shows: active/expiry/date-window gate the whole
 * page, and the catalog is the link's curated item set resolved through
 * the shared `public_link_eligible_items` predicate — the same one the
 * submit endpoint enforces. The payload is PublicCatalogItem only: no
 * sku, cost, location, reserved, or charter data ever serializes here.
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
  const resolved = token && token.length >= 16 ? await resolvePublicRequestToken(token) : null;
  const orgName = resolved?.org.name ?? 'Order request';
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

  // 1. Resolve the token → link + org (links-table first, org-token
  // fallback). 404 silently if the token is unknown. Shared cached lookup
  // with generateMetadata above — same rows, one fetch.
  const resolved = await resolvePublicRequestToken(token);
  if (!resolved) notFound();
  const { org, link } = resolved;

  // 1b. A disabled / expired / out-of-window link renders the friendly
  // "closed" card — the URL is real, the org just isn't taking requests
  // through it right now. (Submit independently re-checks and 404s.)
  if (link && !isLinkOpen(link)) {
    return (
      <ClosedShell org={org}>
        This request link isn&apos;t currently open. Please check back later or
        reach out to the organization directly.
      </ClosedShell>
    );
  }

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
      <ClosedShell org={org}>
        This organization isn&apos;t currently accepting public order requests.
        Please check back later or reach out to them directly.
      </ClosedShell>
    );
  }

  // Pick the active warehouse: prefer ?w= if it's still eligible, else the
  // first one alphabetically. This keeps the warehouse switcher reload-safe.
  const requested = warehouseQuery
    ? warehouses.find((w) => w.id === warehouseQuery) ?? null
    : null;
  const activeWarehouse = requested ?? warehouses[0];
  if (!activeWarehouse) notFound();

  // 3. The link's curated catalog, rendered as PublicCatalogItem directly.
  // link=null is the legacy fallback for a token that predates the 0261
  // backfill — it has no catalog config, so it resolves to an empty catalog
  // (fail closed) and the page shows the "no items available" message.
  const items: PublicCatalogItem[] = link
    ? await getPublicCatalogForLink(link, activeWarehouse.id)
    : [];

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
    <div className="sp-storefront sf-public">
      <BrandRow org={org} />
      <Header
        org={org}
        link={link}
        warehouseName={activeWarehouse.name}
        catalogCount={items.length}
      />
      <PublicOrdersV2
        token={token}
        orgName={org.name}
        warehouses={warehouses}
        initialWarehouseId={activeWarehouse.id}
        items={items}
        availabilityDisplay={link?.availabilityDisplay ?? 'none'}
        chartersForWarehouse={chartersForWarehouse}
      />
      <p className="sfp-track">
        <Link href="/r/track">Track an order you&apos;ve already submitted</Link>
      </p>
    </div>
  );
}

/* ---- org brand row (logo + name) ---------------------------------------- */

function BrandRow({
  org,
}: {
  org: { name: string; logo_url: string | null };
}) {
  return (
    <div className="sfp-brand">
      {isAllowedLogoUrl(org.logo_url) ? (
        <Image
          src={org.logo_url}
          alt={`${org.name} logo`}
          width={40}
          height={40}
          priority
          sizes="40px"
          className="sfp-logo"
        />
      ) : (
        <div className="sfp-logo-fallback">{org.name.slice(0, 1).toUpperCase()}</div>
      )}
      <div className="sfp-org">
        <div className="nm">{org.name}</div>
        <div className="sub">Supply Requests</div>
      </div>
      <span className="sfp-powered">Powered by StockPilot</span>
    </div>
  );
}

/* ---- page head (title + blurb + meta) ------------------------------------ */

function Header({
  org,
  link,
  warehouseName,
  catalogCount,
}: {
  org: { name: string; public_request_blurb: string | null };
  link?: { instructions: string | null } | null;
  warehouseName?: string;
  catalogCount?: number;
}) {
  // Per-link instructions beat the org-wide blurb when set. May contain
  // line breaks — rendered as plain text, breaks preserved (white-space:
  // pre-line on .sf-sub).
  const blurb = link?.instructions?.trim() || org.public_request_blurb;
  return (
    <div className="sf-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="sf-title">Place an order</h1>
        <div className="sf-sub">
          {blurb ||
            'Browse the catalog, add what you need, and tell us how to get it ' +
              "to you. Our team reviews every request before stock is pulled — " +
              "you'll get an email confirmation once it's approved."}
        </div>
      </div>
      {warehouseName && typeof catalogCount === 'number' ? (
        <dl className="sfp-meta">
          <div className="row">
            <dt>Location</dt>
            <dd>
              <span className="d" />
              {warehouseName}
            </dd>
          </div>
          <div className="row">
            <dt>Catalog</dt>
            <dd>
              {catalogCount} {catalogCount === 1 ? 'item' : 'items'} available
            </dd>
          </div>
          <div className="row">
            <dt>Turnaround</dt>
            <dd>Reviewed within 1 business day</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/* ---- closed / not-accepting shell ----------------------------------------- */

function ClosedShell({
  org,
  children,
}: {
  org: { name: string; logo_url: string | null };
  children: ReactNode;
}) {
  return (
    <div className="sp-storefront sf-public">
      <BrandRow org={org} />
      <div className="sf-empty sfp-closed" role="status">
        <div className="big">
          <Ban size={24} aria-hidden />
        </div>
        <h4>Not accepting requests</h4>
        <p>{children}</p>
      </div>
      <p className="sfp-track">
        <Link href="/r/track">Track an order you&apos;ve already submitted</Link>
      </p>
    </div>
  );
}
