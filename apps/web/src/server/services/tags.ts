import 'server-only';

import type { CreateTagInput, UpdateTagInput } from '@stockpilot/core';

import { encodedInValueLength, IN_FILTER_MAX_ENCODED_CHARS } from '@/lib/supabase/in-filter';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRowsByIds, writeInIdBatches } from './lib/fetch-by-ids';

/**
 * Most tags one bulk add/remove may carry. The tag list rides in the SAME
 * URL as each batch of item ids (the remove is a cross product), so it has to
 * be small and fixed for the item batches to have room.
 */
export const MAX_BULK_TAGS = 50;

export interface TagRow {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
}

/**
 * Tags are a flat per-org taxonomy applied to inventory items via the
 * `item_tags` junction table. Unlike categories there is no parent/child
 * tree and no soft-delete column — RLS is the only access gate. Manager+
 * (categories:manage permission) is needed to write; any org member can
 * read. Mirrors the shape of `CategoriesService` for consistency.
 */
export class TagsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new TagsService(await withContext());
  }

  /** All tags in the current org, sorted by name (case-insensitive). */
  async list(): Promise<TagRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('tags')
      .select('id, name, color, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as TagRow[];
  }

  /**
   * Returns tag id + usage count for the management page so we can show
   * "(12 items)" alongside each tag without a per-row round trip. Done
   * via a single grouped read against item_tags joined back to tags.
   */
  async listWithCounts(): Promise<Array<TagRow & { usage_count: number }>> {
    const tags = await this.list();
    if (tags.length === 0) return [];
    const ids = tags.map((t) => t.id);
    // Batched by tag and paged: an org's tags have no cap (one `.in()` past
    // ~215 ids fails), and one row per tagged item was cut at 1000 rows with
    // no error, so busy tags showed low counts. (item_id, tag_id) is the key,
    // so ordering on both keeps pages stable.
    const ctx = this.ctx;
    const data = await fetchAllRowsByIds<{ tag_id: string }>(
      ids,
      (batch) => (from, to) =>
        ctx.supabase
          .from('item_tags')
          .select('tag_id')
          .in('tag_id', batch)
          .order('tag_id')
          .order('item_id')
          .range(from, to),
    );
    const counts = new Map<string, number>();
    for (const row of data) {
      counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + 1);
    }
    return tags.map((t) => ({ ...t, usage_count: counts.get(t.id) ?? 0 }));
  }

  async create(input: CreateTagInput): Promise<TagRow> {
    assertPermission(this.ctx, 'categories:manage');
    const { data, error } = await this.ctx.supabase
      .from('tags')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        color: input.color ?? null,
      })
      .select('id, name, color, created_at')
      .single();
    if (error) {
      // 23505 = unique_violation on (organization_id, name)
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A tag with that name already exists');
      }
      throw new ServiceError('internal_error', error.message);
    }
    void audit({ event: 'tag.created', entityType: 'tag', entityId: data.id, after: data }, this.ctx);
    return data as TagRow;
  }

  async update(id: string, patch: UpdateTagInput): Promise<TagRow> {
    assertPermission(this.ctx, 'categories:manage');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color ?? null;
    if (Object.keys(updates).length === 0) {
      // Nothing to change — re-read so the caller still gets a row back.
      const { data, error } = await this.ctx.supabase
        .from('tags')
        .select('id, name, color, created_at')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw new ServiceError('internal_error', error.message);
      if (!data) throw new ServiceError('not_found', 'Tag not found');
      return data as TagRow;
    }
    const { data, error } = await this.ctx.supabase
      .from('tags')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id, name, color, created_at')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A tag with that name already exists');
      }
      throw new ServiceError('internal_error', error.message);
    }
    void audit({ event: 'tag.updated', entityType: 'tag', entityId: id, after: data }, this.ctx);
    return data as TagRow;
  }

  /**
   * Hard-delete: tags don't carry a deleted_at column, so the row is
   * removed entirely. The FK on item_tags has ON DELETE CASCADE so
   * every (item, tag) link is dropped automatically — no manual cleanup
   * needed.
   */
  async delete(id: string): Promise<void> {
    assertPermission(this.ctx, 'categories:manage');
    const { error } = await this.ctx.supabase
      .from('tags')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit({ event: 'tag.deleted', entityType: 'tag', entityId: id }, this.ctx);
  }

  /**
   * Tags currently applied to a single item, sorted by name. Used by the
   * item edit form to seed the multi-select pill input.
   */
  async listForItem(itemId: string): Promise<TagRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('item_tags')
      .select('tag:tags!inner(id, name, color, created_at, organization_id)')
      .eq('item_id', itemId);
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as Array<{
      tag:
        | {
            id: string;
            name: string;
            color: string | null;
            created_at: string;
            organization_id: string;
          }
        | Array<{
            id: string;
            name: string;
            color: string | null;
            created_at: string;
            organization_id: string;
          }>;
    }>;
    const tags: TagRow[] = [];
    for (const r of rows) {
      // PostgREST returns the joined record as either an object or a
      // single-element array depending on the relationship inference.
      // Normalize to a single tag row and skip anything that escaped
      // the org boundary (defense in depth — RLS already gates this).
      const t = Array.isArray(r.tag) ? r.tag[0] : r.tag;
      if (!t) continue;
      if (t.organization_id !== this.ctx.organizationId) continue;
      tags.push({
        id: t.id,
        name: t.name,
        color: t.color,
        created_at: t.created_at,
      });
    }
    tags.sort((a, b) => a.name.localeCompare(b.name));
    return tags;
  }

  /**
   * Replaces the full tag set for one item. Computes a diff so audit
   * events ('tag.applied' / 'tag.removed') reflect actual transitions
   * — no spurious entries when the user opens the form, doesn't touch
   * tags, and saves.
   */
  async setForItem(itemId: string, tagIds: string[]): Promise<void> {
    assertPermission(this.ctx, 'items:update');

    // Validate every tag belongs to the org. A forged id from a
    // malicious client would otherwise be inserted with the user's
    // org and silently link to nothing (or worse, leak across orgs
    // if RLS were ever loosened).
    const uniqueIds = Array.from(new Set(tagIds));
    if (uniqueIds.length > 0) {
      const { data: validRows, error: validErr } = await this.ctx.supabase
        .from('tags')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        // in-list-bound: setItemTagsSchema caps one item's tag set at 100
        .in('id', uniqueIds);
      if (validErr) throw new ServiceError('internal_error', validErr.message);
      const validSet = new Set(((validRows ?? []) as Array<{ id: string }>).map((r) => r.id));
      for (const id of uniqueIds) {
        if (!validSet.has(id)) {
          throw new ServiceError('validation_error', 'One or more tags are invalid');
        }
      }
    }

    // Verify the item belongs to the org so we don't accidentally write
    // to someone else's row (RLS would block it, but this surfaces a
    // friendlier error).
    const { data: itemRow, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
    if (!itemRow) throw new ServiceError('not_found', 'Item not found');

    const { data: existingRows, error: existingErr } = await this.ctx.supabase
      .from('item_tags')
      .select('tag_id')
      .eq('item_id', itemId);
    if (existingErr) throw new ServiceError('internal_error', existingErr.message);
    const existing = new Set(
      ((existingRows ?? []) as Array<{ tag_id: string }>).map((r) => r.tag_id),
    );
    const next = new Set(uniqueIds);

    const toAdd = [...next].filter((id) => !existing.has(id));
    const toRemove = [...existing].filter((id) => !next.has(id));

    if (toAdd.length > 0) {
      const rows = toAdd.map((tag_id) => ({ item_id: itemId, tag_id }));
      const { error } = await this.ctx.supabase.from('item_tags').insert(rows);
      if (error) throw new ServiceError('internal_error', error.message);
      for (const tagId of toAdd) {
        void audit(
          {
            event: 'tag.applied',
            entityType: 'inventory_item',
            entityId: itemId,
            extra: { tag_id: tagId },
          },
          this.ctx,
        );
      }
    }

    if (toRemove.length > 0) {
      // Batched: an item can carry more tags than the form's 100 after several
      // bulk adds. Tags removed before a failed batch are still audited.
      const ctx = this.ctx;
      const removal = await writeInIdBatches(toRemove, (batch) =>
        ctx.supabase.from('item_tags').delete().eq('item_id', itemId).in('tag_id', batch),
      );
      for (const tagId of removal.written) {
        void audit(
          {
            event: 'tag.removed',
            entityType: 'inventory_item',
            entityId: itemId,
            extra: { tag_id: tagId },
          },
          this.ctx,
        );
      }
      if (removal.error !== null) throw new ServiceError('internal_error', removal.error);
    }
  }

  /**
   * Bulk-applies the given tag ids across many items. Inserts (item_id,
   * tag_id) pairs with ON CONFLICT DO NOTHING semantics so re-running
   * is idempotent. Caller is responsible for filtering itemIds to the
   * set the current user has write access to (InventoryService.bulkUpdate
   * already does this via warehouse-access check).
   */
  async bulkAddToItems(itemIds: string[], tagIds: string[]): Promise<void> {
    assertPermission(this.ctx, 'items:update');
    if (itemIds.length === 0 || tagIds.length === 0) return;

    // Validate tag ids — same defense as setForItem.
    const uniqueTags = Array.from(new Set(tagIds));
    assertBulkTagCount(uniqueTags);
    const { data: validRows, error: validErr } = await this.ctx.supabase
      .from('tags')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: assertBulkTagCount caps a bulk tag list at MAX_BULK_TAGS
      .in('id', uniqueTags);
    if (validErr) throw new ServiceError('internal_error', validErr.message);
    const validSet = new Set(((validRows ?? []) as Array<{ id: string }>).map((r) => r.id));
    const safeTags = uniqueTags.filter((id) => validSet.has(id));
    if (safeTags.length === 0) return;

    const rows: Array<{ item_id: string; tag_id: string }> = [];
    for (const itemId of itemIds) {
      for (const tagId of safeTags) {
        rows.push({ item_id: itemId, tag_id: tagId });
      }
    }
    if (rows.length === 0) return;
    // Default insert errors on duplicate PK (item_id, tag_id). Use upsert
    // with ignoreDuplicates so re-applying an existing tag is a no-op
    // instead of a 409 — the user just wanted those items tagged.
    const { error } = await this.ctx.supabase
      .from('item_tags')
      .upsert(rows, { onConflict: 'item_id,tag_id', ignoreDuplicates: true });
    if (error) throw new ServiceError('internal_error', error.message);

    // One audit row PER item (not one row for the whole batch) so each
    // affected item's own Activity feed / "View history" link actually
    // shows the tag change — a single entityId-less row was invisible
    // everywhere except a raw audit_logs query.
    for (const itemId of new Set(itemIds)) {
      void audit(
        {
          event: 'tag.applied',
          entityType: 'inventory_item',
          entityId: itemId,
          extra: {
            bulk: true,
            item_count: itemIds.length,
            tag_ids: safeTags,
          },
        },
        this.ctx,
      );
    }
  }

  /**
   * Mirror of bulkAddToItems but DELETEs every (item, tag) pair in the cross
   * product.
   *
   * Batched by ITEM: the tag list (at most MAX_BULK_TAGS) rides in every
   * request, so each item batch gets whatever character budget the tag list
   * leaves. One batch at a time; a failure stops the rest. Items whose tags
   * were removed before the failure are audited, and the result names what
   * was and was not changed so the caller can report a partial result.
   */
  async bulkRemoveFromItems(
    itemIds: string[],
    tagIds: string[],
  ): Promise<{ written: string[]; notWritten: string[] }> {
    assertPermission(this.ctx, 'items:update');
    if (itemIds.length === 0 || tagIds.length === 0) return { written: [], notWritten: [] };

    // Validate every tag id belongs to this org — same defense as
    // bulkAddToItems. RLS would already block a delete on a cross-org
    // tag link, but this surfaces a clear error and keeps audit
    // entries honest.
    const uniqueTags = Array.from(new Set(tagIds));
    assertBulkTagCount(uniqueTags);
    const { data: validTags, error: validTagErr } = await this.ctx.supabase
      .from('tags')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: assertBulkTagCount caps a bulk tag list at MAX_BULK_TAGS
      .in('id', uniqueTags);
    if (validTagErr) throw new ServiceError('internal_error', validTagErr.message);
    if ((validTags?.length ?? 0) !== uniqueTags.length) {
      throw new ServiceError(
        'validation_error',
        'One or more tags do not belong to this organization.',
      );
    }

    // Same check on item ids. A forged item id (cross-org or
    // non-existent) is silently no-op'd by RLS today; flag it. Batched:
    // a bulk selection carries up to 500 ids.
    const uniqueItems = Array.from(new Set(itemIds));
    const ctx = this.ctx;
    const validItems = await fetchAllRowsByIds<{ id: string }>(
      uniqueItems,
      (batch) => (from, to) =>
        ctx.supabase
          .from('inventory_items')
          .select('id')
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .order('id')
          .range(from, to),
    );
    if (validItems.length !== uniqueItems.length) {
      throw new ServiceError(
        'validation_error',
        'One or more items do not belong to this organization.',
      );
    }

    const tagListChars = uniqueTags.reduce((n, id) => n + encodedInValueLength(id) + 3, 0);
    const write = await writeInIdBatches(
      uniqueItems,
      (batch) =>
        ctx.supabase
          .from('item_tags')
          .delete()
          .in('item_id', batch)
          // in-list-bound: assertBulkTagCount caps a bulk tag list at MAX_BULK_TAGS
          .in('tag_id', uniqueTags),
      { maxEncodedChars: Math.max(400, IN_FILTER_MAX_ENCODED_CHARS - tagListChars) },
    );
    if (write.error !== null && write.written.length === 0) {
      throw new ServiceError('internal_error', write.error);
    }

    // One audit row per item — same rationale as bulkAddToItems above.
    for (const itemId of write.written) {
      void audit(
        {
          event: 'tag.removed',
          entityType: 'inventory_item',
          entityId: itemId,
          extra: {
            bulk: true,
            item_count: write.written.length,
            tag_ids: uniqueTags,
          },
        },
        this.ctx,
      );
    }
    return { written: write.written, notWritten: write.notWritten };
  }
}

/** A bulk tag change carries at most MAX_BULK_TAGS distinct tags. */
function assertBulkTagCount(uniqueTags: string[]): void {
  if (uniqueTags.length > MAX_BULK_TAGS) {
    throw new ServiceError(
      'validation_error',
      `Apply or remove at most ${MAX_BULK_TAGS} tags at a time.`,
    );
  }
}
