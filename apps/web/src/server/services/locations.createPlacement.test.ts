import { describe, expect, it } from 'vitest';

import { createLocationSchema } from '@/server/services/locations';

describe('createLocationSchema placement fields', () => {
  it('accepts a rack with number + row + warehouse', () => {
    const r = createLocationSchema.safeParse({
      name: '41-B',
      type: 'shelf',
      kind: 'rack',
      warehouseId: '00000000-0000-0000-0000-000000000001',
      rackNumber: '41',
      rackRow: 'B',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a crate with color + number + parent rack', () => {
    const r = createLocationSchema.safeParse({
      name: 'Blue #3',
      type: 'bin',
      kind: 'crate',
      warehouseId: '00000000-0000-0000-0000-000000000001',
      crateColor: 'Blue',
      crateNumber: '3',
      parentId: '00000000-0000-0000-0000-000000000002',
    });
    expect(r.success).toBe(true);
  });
});
