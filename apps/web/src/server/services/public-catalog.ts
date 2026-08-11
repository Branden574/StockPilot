import 'server-only';

import { unstable_cache } from 'next/cache';

import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';

import type {
  PublicAvailability,
  PublicCatalogItem,
} from '@/components/orders/public-v2/types';

import { publicCatalogTag } from './public-links';

/**
 * Public, link-aware catalog loader for the `/r/[token]` order page
 * (migration 0261; plan:
 * docs/superpowers/plans/2026-07-12-public-catalog-visibility-plan.md).
 *
 * ELIGIBILITY is decided by ONE SQL predicate —
 * `public.public_link_eligible_items(link_id, warehouse_id)` — shared with
 * the submit endpoint (/api/v1/public/order-requests), so what the page
 * renders and what the API accepts can never drift. The predicate encodes:
 * item active + not deleted + warehouse publicly orderable + item not
 * 'hidden' + (explicit catalog entry OR public-pool item in a public
 * category on a pool-enabled link) + link active/not expired/inside date
 * window + per-type toggle (books_enabled/items_enabled).
 *
 * SHAPE: `PublicCatalogItem` — the ONLY thing serialized into the anonymous
 * RSC payload / returned by public APIs. It deliberately has NO field for
 * cost, price, sku, rack/bin location, reserved quantities, reorder point,
 * or charter data; leaking any of those is now a compile error, not a
 * remember-to-null-it convention.
 *
 * CACHE: per-(link, warehouse) unstable_cache, 60s revalidate, tag
 * `public-catalog-<linkId>`. Admin mutations (PublicLinksService) call
 * revalidateTag(tag, 'max') so config changes surface immediately; the 60s
 * window only covers organic stock drift. Submit always re-validates fresh,
 * so a stale render fails closed.
 */

// ── Public schema ───────────────────────────────────────────────────────────
// PublicCatalogItem/PublicAvailability live in
// components/orders/public-v2/types.ts (types only — shared verbatim with
// the anonymous UI so server payload and client rendering can't drift).
// Re-exported here so server-side callers keep importing from the service.

export type { PublicAvailability, PublicCatalogItem };

/** Minimal link config the public read path needs. */
export interface PublicLinkConfig {
  id: string;
  organizationId: string;
  name: string;
  instructions: string | null;
  active: boolean;
  expiresAt: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  availabilityDisplay: 'exact' | 'bucket' | 'none';
  booksEnabled: boolean;
  itemsEnabled: boolean;
  includePublicPool: boolean;
  defaultMaxQty: number | null;
}

export interface PublicRequestContext {
  org: {
    id: string;
    name: string;
    logo_url: string | null;
    public_request_blurb: string | null;
  };
  /**
   * null = legacy fallback: the token matched organizations.
   * public_request_token but no links row (possible only for tokens minted
   * outside the links table after migration 0261 backfilled every org).
   */
  link: PublicLinkConfig | null;
}

/**
 * Fixed public low-stock boundary for the 'bucket' display mode. Mirrors
 * PUBLIC_LOW_STOCK_THRESHOLD in components/orders/public-v2/public-logic.ts —
 * the org's real reorder_point is confidential and never ships to anonymous
 * visitors.
 */
const PUBLIC_BUCKET_LOW_THRESHOLD = 5;

/** Hard cap on catalog size, matching the previous loader. */
const CATALOG_LIMIT = 500;

/**
 * External cover URL to ship in the initial SSR payload. ISBN-imported books
 * store their cover in `custom_fields.thumbnail_url` — a public CDN link
 * (Open Library / Google Books) that needs no signing, so it can render with
 * the HTML. Returns the cover at FULL size (e.g. Open Library `-L`): the card
 * renders through next/image, which downscales to the exact display size and
 * re-encodes to WebP/AVIF, so shipping the large source keeps covers SHARP on
 * retina without a large byte cost. (An earlier `-L`→`-M` downsize here made
 * covers upscale ~2.5× in the 220-260px retina cells and read blurry.)
 * Returns null unless the field is a plain http(s) URL — never emits a
 * non-URL custom field onto the public page.
 */
function externalCoverUrl(customFields: Record<string, unknown> | null): string | null {
  const raw = customFields?.thumbnail_url;
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

// ── Token → link/org resolution ─────────────────────────────────────────────

/**
 * Resolves a /r/<token> token: links-table-FIRST (the migrated "General
 * request link" carries each org's legacy token, so existing URLs land
 * here), then the organizations.public_request_token fallback for any
 * token that predates/escaped the 0261 backfill. Cached 60s — same
 * staleness posture as the old getOrgByPublicToken: renders may lag a
 * rotation by up to 60s but submit validates fresh and fails closed.
 */
export async function resolvePublicRequestToken(
  token: string,
): Promise<PublicRequestContext | null> {
  return resolvePublicRequestTokenCached(token);
}

const resolvePublicRequestTokenCached = unstable_cache(
  async (token: string): Promise<PublicRequestContext | null> => {
    const admin = createAdminClient();

    // Module gate for the READ path (review finding 2026-07-12): the submit
    // route already 404s when `public_requests` is disabled, but without
    // this check a previously-shared /r/<token> URL kept rendering the full
    // catalog after an org turned the module off (entitlement boundary
    // enforced write-only). Same posture as submit: optional module, an
    // explicit enabled row is required; resolver returns null → the page
    // 404s without leaking that the org exists. A query error also lands on
    // null (fail closed). Cached with the resolution (60s TTL bounds a
    // module toggle; link mutations revalidate the tag).
    const moduleEnabled = async (orgId: string): Promise<boolean> => {
      const { data } = await admin
        .from('organization_modules')
        .select('module_id')
        .eq('organization_id', orgId)
        .eq('module_id', 'public_requests')
        .eq('enabled', true)
        .maybeSingle();
      return Boolean(data);
    };

    // Migration 0330: the DB stores sha256(token); hash the presented
    // plaintext and compare on the hash column. Equality via the btree
    // index is fine here — see sha256Hex()'s doc comment for why a
    // timing-safe compare buys nothing on this path.
    const tokenHash = sha256Hex(token);
    const { data: linkRow } = await admin
      .from('public_request_links')
      .select(
        'id, organization_id, name, instructions, active, expires_at, available_from, available_until, availability_display, books_enabled, items_enabled, include_public_pool, default_max_qty',
      )
      .eq('token_hash', tokenHash)
      .maybeSingle();

    type LinkRow = {
      id: string;
      organization_id: string;
      name: string;
      instructions: string | null;
      active: boolean;
      expires_at: string | null;
      available_from: string | null;
      available_until: string | null;
      availability_display: 'exact' | 'bucket' | 'none';
      books_enabled: boolean;
      items_enabled: boolean;
      include_public_pool: boolean;
      default_max_qty: number | null;
    };

    const orgSelect = 'id, name, logo_url, public_request_blurb';
    type OrgRow = {
      id: string;
      name: string;
      logo_url: string | null;
      public_request_blurb: string | null;
    };

    if (linkRow) {
      const l = linkRow as LinkRow;
      const { data: orgRow } = await admin
        .from('organizations')
        .select(orgSelect)
        .eq('id', l.organization_id)
        .maybeSingle();
      if (!orgRow || !(await moduleEnabled(l.organization_id))) return null;
      return {
        org: orgRow as OrgRow,
        link: {
          id: l.id,
          organizationId: l.organization_id,
          name: l.name,
          instructions: l.instructions,
          active: l.active,
          expiresAt: l.expires_at,
          availableFrom: l.available_from,
          availableUntil: l.available_until,
          availabilityDisplay: l.availability_display,
          booksEnabled: l.books_enabled,
          itemsEnabled: l.items_enabled,
          includePublicPool: l.include_public_pool,
          defaultMaxQty: l.default_max_qty,
        },
      };
    }

    // Legacy fallback — org token without a links row. Droppable once
    // verified unused in prod (plan, locked decision 1).
    const { data: orgByToken } = await admin
      .from('organizations')
      .select(orgSelect)
      .eq('public_request_token_hash', tokenHash)
      .maybeSingle();
    const legacyOrg = orgByToken as OrgRow | null;
    if (!legacyOrg || !(await moduleEnabled(legacyOrg.id))) return null;
    return { org: legacyOrg, link: null };
  },
  ['public-link-by-token-v1'],
  { revalidate: 60, tags: ['public-org-by-token'] },
);

/** true when the link is enabled AND inside its expiry/date window. */
export function isLinkOpen(
  link: Pick<PublicLinkConfig, 'active' | 'expiresAt' | 'availableFrom' | 'availableUntil'>,
  now: Date = new Date(),
): boolean {
  if (!link.active) return false;
  const t = now.getTime();
  if (link.expiresAt && Date.parse(link.expiresAt) <= t) return false;
  if (link.availableFrom && Date.parse(link.availableFrom) > t) return false;
  if (link.availableUntil && Date.parse(link.availableUntil) < t) return false;
  return true;
}

// ── Link-aware catalog ──────────────────────────────────────────────────────

export async function getPublicCatalogForLink(
  link: Pick<PublicLinkConfig, 'id' | 'organizationId' | 'availabilityDisplay'>,
  warehouseId: string,
): Promise<PublicCatalogItem[]> {
  // The wrapper is created per call so the cache TAG can carry the linkId
  // (unstable_cache tags are fixed at wrap time). The cache KEY is keyParts +
  // the serialized args, so entries stay per-(link, warehouse).
  const cached = unstable_cache(loadPublicCatalogUncached, ['public-link-catalog-v1'], {
    revalidate: 60,
    tags: [publicCatalogTag(link.id)],
  });
  return cached(link.id, link.organizationId, warehouseId, link.availabilityDisplay);
}

async function loadPublicCatalogUncached(
  linkId: string,
  orgId: string,
  warehouseId: string,
  availabilityDisplay: 'exact' | 'bucket' | 'none',
): Promise<PublicCatalogItem[]> {
  const admin = createAdminClient();

  // 1. THE eligibility predicate (shared with submit) → eligible ids + caps.
  const { data: eligibleRows, error: eligErr } = await admin.rpc(
    'public_link_eligible_items',
    { p_link_id: linkId, p_warehouse_id: warehouseId },
  );
  if (eligErr) throw new Error(`public catalog eligibility failed: ${eligErr.message}`);
  const eligible = (eligibleRows ?? []) as Array<{
    item_id: string;
    max_qty: number | null;
  }>;
  if (eligible.length === 0) return [];

  const maxQtyByItem = new Map<string, number | null>(
    eligible.map((r) => [r.item_id, r.max_qty]),
  );
  const eligibleIds = eligible.map((r) => r.item_id);

  // 2. Item rows for the eligible set. ONLY public-safe columns are selected —
  // never unit_cost, retail_price, sku, reorder_point, bin_location,
  // charter_id, or custom_fields.
  type ItemRow = {
    id: string;
    name: string;
    public_display_name: string | null;
    public_description: string | null;
    quantity_on_hand: number | null;
    item_type: string | null;
    category_id: string | null;
    custom_fields: Record<string, unknown> | null;
  };
  const items: ItemRow[] = [];
  for (const chunk of chunked(eligibleIds, 200)) {
    const { data } = await admin
      .from('inventory_items')
      .select(
        'id, name, public_display_name, public_description, quantity_on_hand, item_type, category_id, custom_fields',
      )
      .eq('organization_id', orgId)
      .in('id', chunk);
    items.push(...((data ?? []) as ItemRow[]));
  }

  items.sort((a, b) =>
    (a.public_display_name ?? a.name).localeCompare(b.public_display_name ?? b.name),
  );
  const page = items.slice(0, CATALOG_LIMIT);
  if (page.length === 0) return [];
  const pageIds = page.map((i) => i.id);
  const categoryIds = [
    ...new Set(page.map((i) => i.category_id).filter((v): v is string => Boolean(v))),
  ];

  // 3. Reservations (only when a stock signal ships), category labels, and
  // LQIP blurs in parallel. Signed thumbnail URLs stay deferred to the client.
  const [rsRes, categoriesRes, lqipRes] = await Promise.all([
    availabilityDisplay === 'none'
      ? Promise.resolve({ data: [] as Array<{ item_id: string; quantity: number }> })
      : admin
          .from('stock_reservations')
          .select('item_id, quantity')
          .eq('organization_id', orgId)
          .in('item_id', pageIds)
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
      .in('item_id', pageIds)
      .not('lqip', 'is', null)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true }),
  ]);

  const reservedByItem = new Map<string, number>();
  for (const row of (rsRes.data ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(
      row.item_id,
      (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity),
    );
  }
  const categoryNameById = new Map<string, string>();
  for (const c of (categoriesRes.data ?? []) as Array<{ id: string; name: string }>) {
    categoryNameById.set(c.id, c.name);
  }
  const lqipByItem = new Map<string, string>();
  for (const row of (lqipRes.data ?? []) as Array<{ item_id: string; lqip: string | null }>) {
    if (!lqipByItem.has(row.item_id) && row.lqip) lqipByItem.set(row.item_id, row.lqip);
  }

  return page.map((it): PublicCatalogItem => {
    const net = Math.max(
      0,
      (Number(it.quantity_on_hand) || 0) - (reservedByItem.get(it.id) ?? 0),
    );
    let availability: PublicAvailability;
    if (availabilityDisplay === 'exact') {
      availability = { kind: 'exact', count: net };
    } else if (availabilityDisplay === 'bucket') {
      availability = {
        kind: 'bucket',
        level:
          net <= 0
            ? 'out_of_stock'
            : net <= PUBLIC_BUCKET_LOW_THRESHOLD
              ? 'low_stock'
              : 'in_stock',
      };
    } else {
      availability = { kind: 'none' };
    }
    return {
      id: it.id,
      displayName: it.public_display_name?.trim() || it.name,
      publicDescription: it.public_description ?? null,
      itemType: it.item_type ?? null,
      categoryId: it.category_id ?? null,
      categoryLabel: it.category_id ? categoryNameById.get(it.category_id) ?? null : null,
      // Ship external cover URLs in the initial payload so the browser starts
      // downloading them with the HTML instead of waiting for the deferred
      // client thumbnail fetch (JS + a round-trip). Only public CDN covers
      // (ISBN-imported books) qualify — signed product photos stay deferred
      // (signing 100+ URLs would slow first paint). The client fetch still
      // runs and fills in the signed photos + re-confirms these covers.
      imageUrl: externalCoverUrl(it.custom_fields),
      lqip: lqipByItem.get(it.id) ?? null,
      availability,
      maxQty: maxQtyByItem.get(it.id) ?? null,
    };
  });
}

// (The transitional CatalogItem adapter — toLegacyCatalogItems — and the
// legacy getPublicBookCatalog(orgId, …) export were removed in P4: the
// public UI now renders PublicCatalogItem directly, so the anonymous
// payload simply never carries sku/price/charter/reserved fields, not even
// as empty strings/zeros.)

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
