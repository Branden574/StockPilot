import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkCreateRack, rackDestinationHint } from './create-rack-check';
import { deriveRackFields } from './item-create';

// ./api (pulled in by item-create) and ./supabase (by warehouse-racks) reach
// for native modules at import time; neither exists under node.
vi.mock('./api', () => ({ api: vi.fn() }));
const sb = vi.hoisted(() => ({
  pages: [] as { data: unknown[] | null; error: { message: string } | null }[],
  calls: [] as [string, unknown[]][],
}));
vi.mock('./supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'is', 'order']) {
    chain[m] = (...args: unknown[]) => {
      sb.calls.push([m, args]);
      return chain;
    };
  }
  chain.range = (...args: unknown[]) => {
    sb.calls.push(['range', args]);
    return Promise.resolve(sb.pages.shift() ?? { data: [], error: null });
  };
  return { supabase: chain };
});

const { loadWarehouseRackNames } = await import('./warehouse-racks');

// DC4's real neighbourhood on 2026-09-24 (L4L North Region).
const DC4 = ['17-B', '18-B', '20-A', '22-A', '35', '35-A', '36-A'];

describe('checkCreateRack — the New Item screen must ask before a rack is minted', () => {
  it('replays the incident: "1" + "B" is a NEW rack, and 17-B is offered first', () => {
    const { binLocation } = deriveRackFields({
      itemType: 'product',
      modelNumber: '',
      rackNumber: '1',
      rackRow: 'B',
      customFields: {},
    });
    expect(binLocation).toBe('1-B');
    const check = checkCreateRack({
      binLocation,
      units: 130,
      warehouseName: 'DC4',
      existingRacks: DC4,
    });
    expect(check.kind).toBe('new');
    if (check.kind !== 'new') return;
    expect(check.title).toBe('Create new rack 1-B?');
    expect(check.message).toBe(
      '1-B does not exist in DC4 yet. Continuing creates it and moves 130 units into it. Did you mean 17-B or 18-B?',
    );
    expect(check.suggestions[0]).toBe('17-B');
  });

  it('"Use 17-B instead" rebuilds the same fields the operator meant', () => {
    // The screen re-derives the form with the suggestion in the number box and
    // an empty row; the shared decomposer must split it back into 17 / B.
    const picked = deriveRackFields({
      itemType: 'product',
      modelNumber: '',
      rackNumber: '17-B',
      rackRow: '',
      customFields: {},
    });
    expect(picked.binLocation).toBe('17-B');
    expect(picked.customFields).toEqual({ rack_number: '17', rack_row: 'B' });
    expect(
      checkCreateRack({ binLocation: picked.binLocation, units: 130, warehouseName: 'DC4', existingRacks: DC4 }),
    ).toEqual({ kind: 'existing', label: '17-B' });
  });

  it('an existing rack goes straight through, whatever the casing or spacing', () => {
    for (const typed of ['17-B', '17-b', ' 17 - B ']) {
      expect(
        checkCreateRack({ binLocation: typed, units: 5, warehouseName: 'DC4', existingRacks: DC4 }),
      ).toEqual({ kind: 'existing', label: '17-B' });
    }
  });

  it('asks nothing when nothing would be created: no rack typed, or no stock moving', () => {
    expect(checkCreateRack({ binLocation: null, units: 9, warehouseName: 'DC4', existingRacks: DC4 })).toEqual({
      kind: 'none',
    });
    expect(checkCreateRack({ binLocation: '  ', units: 9, warehouseName: 'DC4', existingRacks: DC4 })).toEqual({
      kind: 'none',
    });
    // The server only auto-places (and so only mints) when on-hand > 0.
    expect(checkCreateRack({ binLocation: '1-B', units: 0, warehouseName: 'DC4', existingRacks: DC4 })).toEqual({
      kind: 'none',
    });
    expect(
      checkCreateRack({ binLocation: '1-B', units: Number.NaN, warehouseName: 'DC4', existingRacks: DC4 }),
    ).toEqual({ kind: 'none' });
  });

  it('a failed rack read ASKS, it never counts as "exists" or as an empty warehouse', () => {
    const check = checkCreateRack({ binLocation: '17-B', units: 1, warehouseName: 'DC4', existingRacks: null });
    expect(check).toEqual({
      kind: 'unchecked',
      label: '17-B',
      title: 'Put the stock on 17-B?',
      message:
        'Could not check the racks in DC4 just now. If 17-B does not exist yet, saving creates it and moves 1 unit into it.',
    });
  });

  it('a brand-new warehouse (no racks at all) still confirms, with no suggestions', () => {
    const check = checkCreateRack({ binLocation: '4-C', units: 2, warehouseName: null, existingRacks: [] });
    expect(check.kind).toBe('new');
    if (check.kind !== 'new') return;
    expect(check.message).toBe('4-C does not exist yet. Continuing creates it and moves 2 units into it.');
    expect(check.suggestions).toEqual([]);
  });
});

describe('rackDestinationHint — the line under the rack boxes', () => {
  it('names the rack the stock is going to', () => {
    expect(rackDestinationHint({ binLocation: '17-b', warehouseName: 'DC4', existingRacks: DC4 })).toEqual({
      text: 'Goes on rack 17-B in DC4.',
      tone: 'ok',
    });
  });
  it('flags a new rack with the likely typo', () => {
    expect(rackDestinationHint({ binLocation: '1-B', warehouseName: 'DC4', existingRacks: DC4 })).toEqual({
      text: '1-B is a new rack in DC4. Did you mean 17-B or 18-B?',
      tone: 'warn',
    });
  });
  it('says so while loading and when the read failed, and is silent with no rack', () => {
    expect(rackDestinationHint({ binLocation: '1-B', warehouseName: 'DC4', existingRacks: undefined })?.tone).toBe(
      'muted',
    );
    expect(rackDestinationHint({ binLocation: '1-B', warehouseName: 'DC4', existingRacks: null })).toEqual({
      text: 'Rack 1-B. Could not check the racks in DC4.',
      tone: 'warn',
    });
    expect(rackDestinationHint({ binLocation: null, warehouseName: 'DC4', existingRacks: DC4 })).toBeNull();
  });
});

describe('loadWarehouseRackNames — the same set the server searches', () => {
  beforeEach(() => {
    sb.pages = [];
    sb.calls = [];
  });

  it('reads live racks of ONE warehouse in the org, in a stable order', async () => {
    sb.pages = [{ data: [{ id: 'a', name: '17-B' }, { id: 'b', name: '1-A' }], error: null }];
    await expect(loadWarehouseRackNames('org-1', 'wh-1')).resolves.toEqual(['17-B', '1-A']);
    expect(sb.calls).toEqual(
      expect.arrayContaining([
        ['from', ['locations']],
        ['eq', ['organization_id', 'org-1']],
        ['eq', ['warehouse_id', 'wh-1']],
        ['eq', ['kind', 'rack']],
        ['is', ['deleted_at', null]],
        ['order', ['id', { ascending: true }]],
      ]),
    );
  });

  it('returns null on a failed read, never an empty list', async () => {
    sb.pages = [{ data: null, error: { message: 'upstream timeout' } }];
    await expect(loadWarehouseRackNames('org-1', 'wh-1')).resolves.toBeNull();
  });
});

describe('New Item screen wiring (source pins)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../app/item/new.tsx'), 'utf8');

  it('the rack boxes are uncontrolled and Save reads the refs', () => {
    expect(src).not.toMatch(/value=\{rackNumber\}/);
    expect(src).not.toMatch(/value=\{rackRow\}/);
    expect(src).toMatch(/rackNumberRef\.current = t;/);
    expect(src).toMatch(/rackRowRef\.current = t;/);
    expect(src).toMatch(/rackNumber: rackNumberRef\.current,/);
    expect(src).toMatch(/rackRow: rackRowRef\.current,/);
  });

  it('both create paths confirm the rack BEFORE anything is sent', () => {
    const save = src.slice(src.indexOf('async function save()'));
    const sized = save.indexOf('submitSizedVariants(built.input)');
    const single = save.indexOf('submitCreateItem(built.input)');
    const confirms = [...save.matchAll(/await confirmRackForCreate\(/g)].map((m) => m.index ?? -1);
    expect(confirms).toHaveLength(2);
    expect(confirms[0]).toBeLessThan(sized);
    expect(confirms[1]).toBeGreaterThan(sized);
    expect(confirms[1]).toBeLessThan(single);
    // A cancel stops the save.
    expect(save.match(/if \(!rackForm\) return;/g)).toHaveLength(2);
  });

  it('the check reads the racks fresh at Save time', () => {
    const fn = src.slice(src.indexOf('async function confirmRackForCreate'), src.indexOf('async function save()'));
    expect(fn).toMatch(/await loadWarehouseRackNames\(orgId, whId\)/);
    expect(fn).toMatch(/checkCreateRack\(/);
  });
});
