import { describe, expect, it } from 'vitest';

import { scopeLocationsToWarehouse } from './scope';

const DC4 = { id: 'a', warehouse_id: 'wh-dc4' };
const LANCASTER = { id: 'b', warehouse_id: 'wh-etc' };
const UNLINKED = { id: 'c', warehouse_id: null };

describe('scopeLocationsToWarehouse', () => {
  it('returns everything when no warehouse is selected', () => {
    expect(scopeLocationsToWarehouse([DC4, LANCASTER, UNLINKED], null)).toHaveLength(3);
  });

  it('hides rows tied to a different warehouse', () => {
    const scoped = scopeLocationsToWarehouse([DC4, LANCASTER, UNLINKED], 'wh-dc4');
    expect(scoped.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('keeps unlinked rows visible under any warehouse filter', () => {
    const scoped = scopeLocationsToWarehouse([UNLINKED], 'wh-etc');
    expect(scoped).toHaveLength(1);
  });
});
