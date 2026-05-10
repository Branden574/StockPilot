import 'server-only';

import type { CreateTagInput, UpdateTagInput } from '@stockpilot/core';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

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
    const { data, error } = await this.ctx.supabase
      .from('item_tags')
      .select('tag_id')
      .in('tag_id', ids);
    if (error) throw new ServiceError('internal_error', error.message);
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as Array<{ tag_id: string }>) {
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
    void audit({ event: 'tag.created', entityType: 'tag', entityId: data.id, after: data });
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
    void audit({ event: 'tag.updated', entityType: 'tag', entityId: id, after: data });
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
    void audit({ event: 'tag.deleted', entityType: 'tag', entityId: id });
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
        void audit({
          event: 'tag.applied',
          entityType: 'inventory_item',
          entityId: itemId,
          extra: { tag_id: tagId },
        });
      }
    }

    if (toRemove.length > 0) {
      const { error } = await this.ctx.supabase
        .from('item_tags')
        .delete()
        .eq('item_id', itemId)
        .in('tag_id', toRemove);
      if (error) throw new ServiceError('internal_error', error.message);
      for (const tagId of toRemove) {
        void audit({
          event: 'tag.removed',
          entityType: 'inventory_item',
          entityId: itemId,
          extra: { tag_id: tagId },
        });
      }
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
    const { data: validRows, error: validErr } = await this.ctx.supabase
      .from('tags')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
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

    void audit({
      event: 'tag.applied',
      entityType: 'inventory_item',
      extra: {
        bulk: true,
        item_count: itemIds.length,
        tag_ids: safeTags,
      },
    });
  }

  /** Mirror of bulkAddToItems but DELETEs every (item, tag) pair in the cross product. */
  async bulkRemoveFromItems(itemIds: string[], tagIds: string[]): Promise<void> {
    assertPermission(this.ctx, 'items:update');
    if (itemIds.length === 0 || tagIds.length === 0) return;

    const { error } = await this.ctx.supabase
      .from('item_tags')
      .delete()
      .in('item_id', itemIds)
      .in('tag_id', tagIds);
    if (error) throw new ServiceError('internal_error', error.message);

    void audit({
      event: 'tag.removed',
      entityType: 'inventory_item',
      extra: {
        bulk: true,
        item_count: itemIds.length,
        tag_ids: tagIds,
      },
    });
  }
}
