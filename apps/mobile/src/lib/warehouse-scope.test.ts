import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WAREHOUSE_SCOPE_META_KEY,
  parseWarehouseScope,
  readPersistedWarehouseScope,
  warehouseScopeMessage,
} from './warehouse-scope';

// db.ts pulls in expo-sqlite (native) — mocked wholesale, vitest runs in
// node. vi.mock/vi.hoisted are hoisted above the imports by vitest's
// transform, so declaring them after keeps import order lint-clean.
const dbMock = vi.hoisted(() => ({
  getMeta: vi.fn<(key: string) => Promise<string | null>>(),
  setMeta: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
vi.mock('./db', () => dbMock);

beforeEach(() => {
  dbMock.getMeta.mockReset().mockResolvedValue(null);
  dbMock.setMeta.mockReset().mockResolvedValue(undefined);
});

describe('parseWarehouseScope', () => {
  it('null / missing → null (not loaded, no banner)', () => {
    expect(parseWarehouseScope(null)).toBeNull();
  });

  it('garbage JSON → null', () => {
    expect(parseWarehouseScope('not-json{')).toBeNull();
  });

  it('non-object / wrong types → null', () => {
    expect(parseWarehouseScope('"scoped"')).toBeNull();
    expect(parseWarehouseScope('[]')).toBeNull();
    expect(parseWarehouseScope(JSON.stringify({ warehouseNames: ['A'] }))).toBeNull();
    expect(parseWarehouseScope(JSON.stringify({ hasAllAccess: 'yes' }))).toBeNull();
  });

  it('valid payload parses; non-string names are dropped', () => {
    expect(
      parseWarehouseScope(
        JSON.stringify({ hasAllAccess: false, warehouseNames: ['Main', 7, null, 'Annex'] }),
      ),
    ).toEqual({ hasAllAccess: false, warehouseNames: ['Main', 'Annex'] });
  });

  it('missing warehouseNames defaults to []', () => {
    expect(parseWarehouseScope(JSON.stringify({ hasAllAccess: true }))).toEqual({
      hasAllAccess: true,
      warehouseNames: [],
    });
  });
});

describe('warehouseScopeMessage', () => {
  it('not loaded (undefined/null) → no banner', () => {
    expect(warehouseScopeMessage(undefined)).toBeNull();
    expect(warehouseScopeMessage(null)).toBeNull();
  });

  it('all-access → no banner', () => {
    expect(warehouseScopeMessage({ hasAllAccess: true, warehouseNames: ['Main'] })).toBeNull();
  });

  it('scoped to one warehouse', () => {
    expect(warehouseScopeMessage({ hasAllAccess: false, warehouseNames: ['Main'] })).toBe(
      "You're viewing Main only. An admin can adjust warehouse access from the Team page.",
    );
  });

  it('scoped to several warehouses, comma-joined', () => {
    expect(
      warehouseScopeMessage({ hasAllAccess: false, warehouseNames: ['Main', 'Annex'] }),
    ).toBe(
      "You're viewing Main, Annex only. An admin can adjust warehouse access from the Team page.",
    );
  });

  it('scoped with zero assignments gets the no-assignment variant', () => {
    expect(warehouseScopeMessage({ hasAllAccess: false, warehouseNames: [] })).toBe(
      'You have no assigned warehouses. An admin can adjust warehouse access from the Team page.',
    );
  });
});

describe('readPersistedWarehouseScope', () => {
  it('reads + parses the persisted meta value', async () => {
    dbMock.getMeta.mockResolvedValue(
      JSON.stringify({ hasAllAccess: false, warehouseNames: ['Main'] }),
    );
    await expect(readPersistedWarehouseScope()).resolves.toEqual({
      hasAllAccess: false,
      warehouseNames: ['Main'],
    });
    expect(dbMock.getMeta).toHaveBeenCalledWith(WAREHOUSE_SCOPE_META_KEY);
  });

  it('nothing persisted → null', async () => {
    await expect(readPersistedWarehouseScope()).resolves.toBeNull();
  });
});
