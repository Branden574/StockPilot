import 'server-only';

import { revalidateTag } from 'next/cache';
import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';

import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { audit } from './audit';

/**
 * Public request links — admin-side CRUD for the per-link curated public
 * catalogs (migration 0261, plan:
 * docs/superpowers/plans/2026-07-12-public-catalog-visibility-plan.md).
 *
 * A link = one shareable /r/<token> URL with its own catalog config
 * (explicit item allowlist + optional public pool, per-type toggles, date
 * window, qty caps). The anonymous read/submit surfaces resolve eligibility
 * through the SQL predicate `public_link_eligible_items` (service-role RPC);
 * this service only manages the config rows, on the USER-authed client so
 * RLS (org scope + admin-or-`public_links:manage`) re-enforces every write.
 *
 * Every mutation that can change what a link exposes ends with
 * `revalidateTag('public-catalog-<linkId>', 'max')` so the cached public
 * catalog refreshes immediately (never updateTag — it throws at runtime in
 * this Next config).
 */

// ── Schemas ─────────────────────────────────────────────────────────────────

export const publicLinkSchema = z.object({
  name: z.string().trim().min(1).max(160),
  purpose: z.string().trim().max(500).nullish(),
  instructions: z.string().trim().max(4000).nullish(),
  active: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullish(),
  availableFrom: z.string().datetime({ offset: true }).nullish(),
  availableUntil: z.string().datetime({ offset: true }).nullish(),
  availabilityDisplay: z.enum(['exact', 'bucket', 'none']).optional(),
  booksEnabled: z.boolean().optional(),
  itemsEnabled: z.boolean().optional(),
  includePublicPool: z.boolean().optional(),
  defaultMaxQty: z.number().int().positive().max(10_000).nullish(),
});
export type PublicLinkInput = z.infer<typeof publicLinkSchema>;

export interface PublicLinkRow {
  id: string;
  name: string;
  purpose: string | null;
  instructions: string | null;
  token: string;
  active: boolean;
  expires_at: string | null;
  available_from: string | null;
  available_until: string | null;
  availability_display: 'exact' | 'bucket' | 'none';
  books_enabled: boolean;
  items_enabled: boolean;
  include_public_pool: boolean;
  default_max_qty: number | null;
  created_at: string;
  updated_at: string;
  entry_count: number;
}

export interface PublicLinkEntryRow {
  item_id: string;
  max_qty_per_request: number | null;
  name: string | null;
  sku: string | null;
}

/** One row of the per-link catalog editor's item picker. */
export interface PublicLinkCandidateRow {
  id: string;
  name: string;
  sku: string | null;
  item_type: string | null;
  status: string;
  category_id: string | null;
  warehouse_id: string | null;
  public_visibility: 'internal_only' | 'public' | 'hidden';
  /** true when the item already has a catalog entry on THIS link. */
  on_link: boolean;
  /** The entry's per-request cap when on the link (null = link default). */
  max_qty_per_request: number | null;
}

export interface CandidateSearchInput {
  /** Matches name OR sku (ilike). */
  search?: string;
  /** Category uuid, or the literal 'none' for uncategorized items. */
  categoryId?: string;
  /** 'book' = books only; 'item' = everything that is not a book. */
  itemType?: 'book' | 'item';
  warehouseId?: string;
  /** Restrict to items that already have an entry on this link. */
  onLinkOnly?: boolean;
  /** 1-based. */
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'sku' | 'created';
  sortDir?: 'asc' | 'desc';
}

export interface EffectiveCatalogCount {
  /** Items the public actually sees on this link right now, summed across
   *  the org's public-orderable warehouses (each item lives in exactly one
   *  warehouse, so the per-warehouse counts are disjoint). */
  total: number;
  byWarehouse: Array<{ warehouseId: string; count: number }>;
}

/** Cache tag for one link's public catalog (all warehouses share it). */
export function publicCatalogTag(linkId: string): string {
  return `public-catalog-${linkId}`;
}

/**
 * Cache tag for the token → link/org resolver (public-catalog.ts). One
 * global tag: link-config mutations are rare admin actions, and dropping
 * every cached resolution costs one indexed re-query per next visit. Without
 * this, a rotated/disabled link keeps RENDERING for up to 60s (submits
 * already fail closed — the POST route reads the links table fresh), and an
 * availability-display change keeps leaking the old mode for up to 60s.
 */
export const PUBLIC_TOKEN_RESOLVE_TAG = 'public-org-by-token';

const LINK_SELECT =
  'id, name, purpose, instructions, token, active, expires_at, available_from, ' +
  'available_until, availability_display, books_enabled, items_enabled, ' +
  'include_public_pool, default_max_qty, created_at, updated_at';

export class PublicLinksService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<PublicLinksService> {
    return new PublicLinksService(await withContext());
  }

  private gate(): void {
    assertModuleEnabled(this.ctx, 'public_requests');
    assertPermission(this.ctx, 'public_links:manage');
  }

  // ── Links ─────────────────────────────────────────────────────────────────

  async list(): Promise<PublicLinkRow[]> {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .select(`${LINK_SELECT}, public_link_catalog_entries(count)`)
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const counts = r.public_link_catalog_entries as Array<{ count: number }> | null;
      const { public_link_catalog_entries: _drop, ...rest } = r;
      return {
        ...(rest as unknown as Omit<PublicLinkRow, 'entry_count'>),
        entry_count: counts?.[0]?.count ?? 0,
      };
    });
  }

  async get(id: string): Promise<PublicLinkRow> {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .select(`${LINK_SELECT}, public_link_catalog_entries(count)`)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');
    const r = data as Record<string, unknown>;
    const counts = r.public_link_catalog_entries as Array<{ count: number }> | null;
    const { public_link_catalog_entries: _drop, ...rest } = r;
    return {
      ...(rest as unknown as Omit<PublicLinkRow, 'entry_count'>),
      entry_count: counts?.[0]?.count ?? 0,
    };
  }

  async create(input: PublicLinkInput): Promise<{ id: string; token: string }> {
    this.gate();
    const parsed = publicLinkSchema.parse(input);
    const token = generateToken();
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .insert({
        organization_id: this.ctx.organizationId,
        name: parsed.name,
        purpose: parsed.purpose ?? null,
        instructions: parsed.instructions ?? null,
        token,
        active: parsed.active ?? true,
        expires_at: parsed.expiresAt ?? null,
        available_from: parsed.availableFrom ?? null,
        available_until: parsed.availableUntil ?? null,
        ...(parsed.availabilityDisplay
          ? { availability_display: parsed.availabilityDisplay }
          : {}),
        ...(parsed.booksEnabled !== undefined ? { books_enabled: parsed.booksEnabled } : {}),
        ...(parsed.itemsEnabled !== undefined ? { items_enabled: parsed.itemsEnabled } : {}),
        ...(parsed.includePublicPool !== undefined
          ? { include_public_pool: parsed.includePublicPool }
          : {}),
        default_max_qty: parsed.defaultMaxQty ?? null,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    const id = (data as { id: string }).id;
    await audit(
      {
        event: 'public_link.created',
        entityType: 'public_request_link',
        entityId: id,
        extra: { link_id: id, name: parsed.name },
      },
      this.ctx,
    );
    return { id, token };
  }

  /**
   * Duplicates a link: same catalog config and catalog entries under a fresh
   * token, name suffixed "(copy)". The copy is ALWAYS inserted inactive — a
   * duplicated PUBLIC link must never go live without an explicit enable,
   * because the admin has not yet reviewed what the copied catalog exposes
   * under the new URL.
   */
  async duplicate(id: string): Promise<{ id: string }> {
    this.gate();

    // Load the full source config org-scoped (same select as get()).
    const { data: source, error: srcErr } = await this.ctx.supabase
      .from('public_request_links')
      .select(LINK_SELECT)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (srcErr) throw new ServiceError('internal_error', srcErr.message);
    if (!source) throw new ServiceError('not_found', 'Public link not found');
    const src = source as unknown as Omit<PublicLinkRow, 'entry_count'>;

    const token = generateToken();
    const { data: created, error: insErr } = await this.ctx.supabase
      .from('public_request_links')
      .insert({
        organization_id: this.ctx.organizationId,
        name: `${src.name} (copy)`.slice(0, 160),
        purpose: src.purpose,
        instructions: src.instructions,
        token,
        // Never live on creation — see the method doc comment.
        active: false,
        expires_at: src.expires_at,
        available_from: src.available_from,
        available_until: src.available_until,
        availability_display: src.availability_display,
        books_enabled: src.books_enabled,
        items_enabled: src.items_enabled,
        include_public_pool: src.include_public_pool,
        default_max_qty: src.default_max_qty,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (insErr) throw new ServiceError('internal_error', insErr.message);
    const newId = (created as { id: string }).id;

    // Copy ALL catalog entries, page by page ordered by item_id (review
    // finding 2026-07-12: a single .limit(2000) read silently sampled an
    // arbitrary subset for links over 2000 entries — 0261's freeze seeds one
    // entry per book, so book-heavy orgs get there with zero admin action).
    // Read page + insert page per loop turn keeps each statement bounded.
    const PAGE = 500;
    for (let offset = 0; ; offset += PAGE) {
      const { data: entries, error: entErr } = await this.ctx.supabase
        .from('public_link_catalog_entries')
        .select('item_id, max_qty_per_request')
        .eq('link_id', id)
        .order('item_id', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (entErr) throw new ServiceError('internal_error', entErr.message);
      const page = (entries ?? []) as Array<{
        item_id: string;
        max_qty_per_request: number | null;
      }>;
      if (page.length === 0) break;
      const { error: chunkErr } = await this.ctx.supabase.from('public_link_catalog_entries').insert(
        page.map((e) => ({
          link_id: newId,
          item_id: e.item_id,
          max_qty_per_request: e.max_qty_per_request ?? null,
        })),
      );
      if (chunkErr) throw new ServiceError('internal_error', chunkErr.message);
      if (page.length < PAGE) break;
    }

    await audit(
      {
        event: 'public_link.created',
        entityType: 'public_request_link',
        entityId: newId,
        extra: { link_id: newId, action: 'duplicated', source_link_id: id },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(newId), 'max');
    return { id: newId };
  }

  async update(id: string, input: PublicLinkInput): Promise<void> {
    this.gate();
    const parsed = publicLinkSchema.parse(input);
    const before = await this.loadForAudit(id);
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .update({
        name: parsed.name,
        purpose: parsed.purpose ?? null,
        instructions: parsed.instructions ?? null,
        ...(parsed.active !== undefined ? { active: parsed.active } : {}),
        expires_at: parsed.expiresAt ?? null,
        available_from: parsed.availableFrom ?? null,
        available_until: parsed.availableUntil ?? null,
        ...(parsed.availabilityDisplay
          ? { availability_display: parsed.availabilityDisplay }
          : {}),
        ...(parsed.booksEnabled !== undefined ? { books_enabled: parsed.booksEnabled } : {}),
        ...(parsed.itemsEnabled !== undefined ? { items_enabled: parsed.itemsEnabled } : {}),
        ...(parsed.includePublicPool !== undefined
          ? { include_public_pool: parsed.includePublicPool }
          : {}),
        default_max_qty: parsed.defaultMaxQty ?? null,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id, active')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');
    const disabled = before.active && parsed.active === false;
    await audit(
      {
        event: disabled ? 'public_link.disabled' : 'public_link.updated',
        entityType: 'public_request_link',
        entityId: id,
        before,
        after: { ...parsed },
        extra: { link_id: id },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(id), 'max');
    revalidateTag(PUBLIC_TOKEN_RESOLVE_TAG, 'max');
  }

  async setActive(id: string, active: boolean): Promise<void> {
    this.gate();
    const before = await this.loadForAudit(id);
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .update({ active })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');
    await audit(
      {
        event: active ? 'public_link.updated' : 'public_link.disabled',
        entityType: 'public_request_link',
        entityId: id,
        before: { active: before.active },
        after: { active },
        extra: { link_id: id },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(id), 'max');
    revalidateTag(PUBLIC_TOKEN_RESOLVE_TAG, 'max');
  }

  /**
   * Mints a fresh token for the link — the old URL stops resolving
   * immediately. When the link is the org's migrated "General request link"
   * (its token matches organizations.public_request_token), the org column is
   * kept in sync so the legacy fallback + /r/track token checks keep agreeing
   * with the links table.
   */
  async rotateToken(id: string): Promise<{ token: string }> {
    this.gate();
    const before = await this.loadForAudit(id);
    const token = generateToken();
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .update({ token })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');

    // Legacy-column sync (General link only). organizations RLS requires
    // admin+ for the update; if the caller is a lower-role grantee the org
    // column write is skipped rather than failing the rotation — the link
    // table is authoritative for /r/<token> resolution.
    const { data: orgRow } = await this.ctx.supabase
      .from('organizations')
      .select('public_request_token')
      .eq('id', this.ctx.organizationId)
      .maybeSingle();
    if (
      (orgRow as { public_request_token?: string | null } | null)?.public_request_token ===
      before.token
    ) {
      await this.ctx.supabase
        .from('organizations')
        .update({
          public_request_token: token,
          public_request_token_rotated_at: new Date().toISOString(),
        })
        .eq('id', this.ctx.organizationId);
    }

    await audit(
      {
        event: 'public_link.updated',
        entityType: 'public_request_link',
        entityId: id,
        extra: { link_id: id, action: 'token_rotated' },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(id), 'max');
    revalidateTag(PUBLIC_TOKEN_RESOLVE_TAG, 'max');
    return { token };
  }

  async remove(id: string): Promise<void> {
    this.gate();
    const before = await this.loadForAudit(id);
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');
    await audit(
      {
        event: 'public_link.disabled',
        entityType: 'public_request_link',
        entityId: id,
        before,
        extra: { link_id: id, action: 'deleted' },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(id), 'max');
    revalidateTag(PUBLIC_TOKEN_RESOLVE_TAG, 'max');
  }

  // ── Catalog entries ───────────────────────────────────────────────────────

  async listEntries(linkId: string): Promise<PublicLinkEntryRow[]> {
    this.gate();
    await this.assertLinkInOrg(linkId);
    const { data, error } = await this.ctx.supabase
      .from('public_link_catalog_entries')
      .select('item_id, max_qty_per_request, item:inventory_items(name, sku)')
      .eq('link_id', linkId)
      .limit(2000);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const item = r.item as
        | { name: string | null; sku: string | null }
        | Array<{ name: string | null; sku: string | null }>
        | null;
      const itemObj = Array.isArray(item) ? item[0] : item;
      return {
        item_id: r.item_id as string,
        max_qty_per_request: (r.max_qty_per_request as number | null) ?? null,
        name: itemObj?.name ?? null,
        sku: itemObj?.sku ?? null,
      };
    });
  }

  /**
   * Adds (or re-caps) items on a link's catalog. Upsert so re-adding an item
   * with a new cap is one call. Emits entry_added for a single item and
   * bulk_change for multi-item calls.
   */
  async addEntries(
    linkId: string,
    itemIds: string[],
    maxQtyPerRequest?: number | null,
  ): Promise<{ added: number }> {
    this.gate();
    await this.assertLinkInOrg(linkId);
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return { added: 0 };
    if (ids.length > 1000) {
      throw new ServiceError('validation_error', 'Too many items in one change (max 1000).');
    }
    if (
      maxQtyPerRequest !== undefined &&
      maxQtyPerRequest !== null &&
      (!Number.isInteger(maxQtyPerRequest) || maxQtyPerRequest <= 0)
    ) {
      throw new ServiceError('validation_error', 'Quantity limit must be a positive integer.');
    }

    // Org check on every item id — the RLS with-check re-enforces this via
    // item_in_org, but a friendly error beats a bare 42501.
    const { data: items, error: itemsErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', ids)
      .is('deleted_at', null);
    if (itemsErr) throw new ServiceError('internal_error', itemsErr.message);
    const found = new Set(((items ?? []) as Array<{ id: string }>).map((i) => i.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ServiceError('not_found', 'One or more items were not found.');
    }

    const { error } = await this.ctx.supabase.from('public_link_catalog_entries').upsert(
      ids.map((itemId) => ({
        link_id: linkId,
        item_id: itemId,
        max_qty_per_request: maxQtyPerRequest ?? null,
      })),
      { onConflict: 'link_id,item_id' },
    );
    if (error) throw new ServiceError('internal_error', error.message);

    await audit(
      {
        event: ids.length === 1 ? 'public_catalog.entry_added' : 'public_catalog.bulk_change',
        entityType: 'public_request_link',
        entityId: linkId,
        extra: {
          link_id: linkId,
          action: 'entries_added',
          item_id: ids.length === 1 ? ids[0] : null,
          item_ids: ids,
          max_qty_per_request: maxQtyPerRequest ?? null,
        },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(linkId), 'max');
    return { added: ids.length };
  }

  async removeEntries(linkId: string, itemIds: string[]): Promise<{ removed: number }> {
    this.gate();
    await this.assertLinkInOrg(linkId);
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return { removed: 0 };
    if (ids.length > 1000) {
      throw new ServiceError('validation_error', 'Too many items in one change (max 1000).');
    }
    const { error } = await this.ctx.supabase
      .from('public_link_catalog_entries')
      .delete()
      .eq('link_id', linkId)
      .in('item_id', ids);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: ids.length === 1 ? 'public_catalog.entry_removed' : 'public_catalog.bulk_change',
        entityType: 'public_request_link',
        entityId: linkId,
        extra: {
          link_id: linkId,
          action: 'entries_removed',
          item_id: ids.length === 1 ? ids[0] : null,
          item_ids: ids,
        },
      },
      this.ctx,
    );
    revalidateTag(publicCatalogTag(linkId), 'max');
    return { removed: ids.length };
  }

  /**
   * Paginated, filterable picker feed for the per-link catalog editor: the
   * org's items+books with each row's public_visibility and whether it is
   * already on this link. USER-authed client, so inventory RLS (org scope +
   * category restrictions) applies to what the admin can browse.
   */
  async searchCandidates(
    linkId: string,
    input: CandidateSearchInput = {},
  ): Promise<{ rows: PublicLinkCandidateRow[]; total: number }> {
    this.gate();
    await this.assertLinkInOrg(linkId);

    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
    const from = (page - 1) * pageSize;

    // Left-embed the entries table filtered to THIS link: rows come back with
    // 0 or 1 embedded entry, which is exactly the "already on this link"
    // signal. `!inner` flips the same join into an on-link-only filter.
    const embed = input.onLinkOnly
      ? 'entry:public_link_catalog_entries!inner(link_id, max_qty_per_request)'
      : 'entry:public_link_catalog_entries(link_id, max_qty_per_request)';

    let query = this.ctx.supabase
      .from('inventory_items')
      .select(
        `id, name, sku, item_type, status, category_id, warehouse_id, public_visibility, ${embed}`,
        { count: 'exact' },
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('entry.link_id', linkId);

    if (input.search && input.search.trim()) {
      // Same .or() sanitization as InventoryService.list — strip characters
      // that would let a term escape its clause (commas, parens, wildcards).
      const term = input.search.trim().slice(0, 120).replace(/[,()%*]/g, ' ').trim();
      if (term) {
        query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
      }
    }
    if (input.categoryId === 'none') {
      query = query.is('category_id', null);
    } else if (input.categoryId) {
      query = query.eq('category_id', input.categoryId);
    }
    if (input.itemType === 'book') {
      query = query.eq('item_type', 'book');
    } else if (input.itemType === 'item') {
      // NULL item_type is legacy 'product' — keep those in the non-book set.
      query = query.or('item_type.neq.book,item_type.is.null');
    }
    if (input.warehouseId) {
      query = query.eq('warehouse_id', input.warehouseId);
    }

    const sort = input.sort ?? 'name';
    const ascending = (input.sortDir ?? 'asc') === 'asc';
    const sortColumn = sort === 'sku' ? 'sku' : sort === 'created' ? 'created_at' : 'name';
    query = query
      .order(sortColumn, { ascending })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const entryRaw = r.entry as
        | { link_id: string; max_qty_per_request: number | null }
        | Array<{ link_id: string; max_qty_per_request: number | null }>
        | null;
      const entry = Array.isArray(entryRaw) ? entryRaw[0] ?? null : entryRaw;
      return {
        id: r.id as string,
        name: r.name as string,
        sku: (r.sku as string | null) ?? null,
        item_type: (r.item_type as string | null) ?? null,
        status: r.status as string,
        category_id: (r.category_id as string | null) ?? null,
        warehouse_id: (r.warehouse_id as string | null) ?? null,
        public_visibility: r.public_visibility as PublicLinkCandidateRow['public_visibility'],
        on_link: Boolean(entry),
        max_qty_per_request: entry?.max_qty_per_request ?? null,
      } satisfies PublicLinkCandidateRow;
    });
    return { rows, total: count ?? rows.length };
  }

  /**
   * What the public ACTUALLY sees on this link right now — resolved through
   * the same `public_link_eligible_items` RPC the anonymous catalog and
   * submit endpoint use, so the number reflects entries + public pool minus
   * hidden/archived items, per-type toggles, link window, and closed
   * warehouses. The RPC is service-role-only, so this runs on the admin
   * client AFTER the user-authed org/permission checks above prove access.
   */
  async effectiveCatalogCount(linkId: string): Promise<EffectiveCatalogCount> {
    this.gate();
    await this.assertLinkInOrg(linkId);

    const { data: whs, error: whErr } = await this.ctx.supabase
      .from('warehouses')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('is_public_orderable', true);
    if (whErr) throw new ServiceError('internal_error', whErr.message);
    const warehouseIds = ((whs ?? []) as Array<{ id: string }>).map((w) => w.id);
    if (warehouseIds.length === 0) return { total: 0, byWarehouse: [] };

    const admin = createAdminClient();
    const byWarehouse = await Promise.all(
      warehouseIds.map(async (warehouseId) => {
        const { count, error } = await admin.rpc(
          'public_link_eligible_items',
          { p_link_id: linkId, p_warehouse_id: warehouseId },
          { head: true, count: 'exact' },
        );
        if (error) throw new ServiceError('internal_error', error.message);
        return { warehouseId, count: count ?? 0 };
      }),
    );
    return {
      total: byWarehouse.reduce((sum, w) => sum + w.count, 0),
      byWarehouse,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async assertLinkInOrg(linkId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', linkId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');
  }

  private async loadForAudit(id: string): Promise<{
    active: boolean;
    token: string;
    name: string;
    include_public_pool: boolean;
    books_enabled: boolean;
    items_enabled: boolean;
    default_max_qty: number | null;
  }> {
    const { data, error } = await this.ctx.supabase
      .from('public_request_links')
      .select('active, token, name, include_public_pool, books_enabled, items_enabled, default_max_qty')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Public link not found');
    return data as {
      active: boolean;
      token: string;
      name: string;
      include_public_pool: boolean;
      books_enabled: boolean;
      items_enabled: boolean;
      default_max_qty: number | null;
    };
  }
}

/**
 * 256-bit hex token — same mint as the legacy org token
 * (order-requests.ts generateToken) so every /r/<token> URL has one shape.
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
