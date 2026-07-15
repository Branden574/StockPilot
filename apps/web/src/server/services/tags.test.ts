import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Movement/Activity P2 Task 1e: bulkAddToItems/bulkRemoveFromItems used to
// emit ONE audit row for the whole batch with no entityId — invisible in
// any per-item "View history" / Activity feed. Mock the writer so these
// tests can assert one row PER affected item, each carrying entityId=itemId.
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { audit } from './audit';
import { TagsService } from './tags';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TagsService.bulkAddToItems', () => {
  it('emits one tag.applied audit row per affected item, each with entityId=itemId', async () => {
    const stub = makeSupabaseStub({
      'tags.select': { data: [{ id: 'tag-1' }, { id: 'tag-2' }], error: null },
      'item_tags.upsert': { data: null, error: null },
    });
    const svc = new TagsService(makeServiceContext(stub.client));

    await svc.bulkAddToItems(['item-1', 'item-2'], ['tag-1', 'tag-2']);

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tag.applied',
        entityType: 'inventory_item',
        entityId: 'item-1',
        extra: expect.objectContaining({ bulk: true, tag_ids: ['tag-1', 'tag-2'] }),
      }),
      expect.anything(),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tag.applied',
        entityType: 'inventory_item',
        entityId: 'item-2',
      }),
      expect.anything(),
    );
  });

  it('dedupes repeated item ids so a caller passing duplicates does not double-audit', async () => {
    const stub = makeSupabaseStub({
      'tags.select': { data: [{ id: 'tag-1' }], error: null },
      'item_tags.upsert': { data: null, error: null },
    });
    const svc = new TagsService(makeServiceContext(stub.client));

    await svc.bulkAddToItems(['item-1', 'item-1'], ['tag-1']);

    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('no-ops (and never audits) when itemIds is empty', async () => {
    const stub = makeSupabaseStub();
    const svc = new TagsService(makeServiceContext(stub.client));

    await svc.bulkAddToItems([], ['tag-1']);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('TagsService.bulkRemoveFromItems', () => {
  it('emits one tag.removed audit row per affected item, each with entityId=itemId', async () => {
    const stub = makeSupabaseStub({
      'tags.select': { data: [{ id: 'tag-1' }], error: null },
      'inventory_items.select': { data: [{ id: 'item-1' }, { id: 'item-2' }], error: null },
      'item_tags.delete': { data: null, error: null },
    });
    const svc = new TagsService(makeServiceContext(stub.client));

    await svc.bulkRemoveFromItems(['item-1', 'item-2'], ['tag-1']);

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tag.removed',
        entityType: 'inventory_item',
        entityId: 'item-1',
        extra: expect.objectContaining({ bulk: true, tag_ids: ['tag-1'] }),
      }),
      expect.anything(),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tag.removed',
        entityType: 'inventory_item',
        entityId: 'item-2',
      }),
      expect.anything(),
    );
  });
});
