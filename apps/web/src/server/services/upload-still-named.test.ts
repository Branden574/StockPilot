import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  answers: [] as Array<{ data: unknown; error: { message: string } | null }>,
  calls: [] as Array<{ table: string; column: string; paths: string[]; limit: number }>,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (_cols: string) => ({
        in: (column: string, paths: string[]) => ({
          limit: async (limit: number) => {
            h.calls.push({ table, column, paths, limit });
            return h.answers.shift() ?? { data: [], error: null };
          },
        }),
      }),
    }),
  }),
}));

import { uploadObjectsStillNamed } from './upload-still-named';

beforeEach(() => {
  h.answers = [];
  h.calls = [];
});

/** Part 6: the look before a refused upload's objects are removed. */
describe('uploadObjectsStillNamed', () => {
  it('asks each column for any row naming one of the paths', async () => {
    expect(await uploadObjectsStillNamed('procedure_videos', ['storage_path', 'thumbnail_path'], ['a', 'b'])).toBe(false);
    expect(h.calls).toEqual([
      { table: 'procedure_videos', column: 'storage_path', paths: ['a', 'b'], limit: 1 },
      { table: 'procedure_videos', column: 'thumbnail_path', paths: ['a', 'b'], limit: 1 },
    ]);
  });

  it('a row in any column is "still named", and the look stops there', async () => {
    h.answers = [{ data: [{ id: 'row-1' }], error: null }];
    expect(await uploadObjectsStillNamed('item_images', ['storage_path', 'thumb_path'], ['a'])).toBe(true);
    expect(h.calls).toHaveLength(1);
    h.calls = [];
    h.answers = [{ data: [], error: null }, { data: [{ id: 'row-2' }], error: null }];
    expect(await uploadObjectsStillNamed('item_images', ['storage_path', 'thumb_path'], ['a'])).toBe(true);
  });

  it('a failed look throws (the caller keeps the objects); no paths asks nothing', async () => {
    h.answers = [{ data: null, error: { message: 'down' } }];
    await expect(uploadObjectsStillNamed('po_attachments', ['storage_path'], ['a'])).rejects.toThrow();
    h.calls = [];
    expect(await uploadObjectsStillNamed('po_attachments', ['storage_path'], [])).toBe(false);
    expect(h.calls).toEqual([]);
  });
});
