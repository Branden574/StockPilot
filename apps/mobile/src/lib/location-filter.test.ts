import { describe, expect, it } from 'vitest';

import { PLACEMENT_KINDS, PLACEMENT_TYPES, SYSTEM_KINDS, isSiteLocation } from '@stockpilot/core';

import { SITE_KIND_FILTER, SITE_TYPE_FILTER, onlySiteLocations } from './location-filter';

/**
 * B28 (2026-10-25): the phone's location filter offers the sites the web's
 * does (core isSiteLocation), and the filter strings are the SQL mirror of it.
 * Evaluates the two PostgREST groups the way the database does (`kind.is.null`
 * OR `kind NOT IN (...)`, AND the same for type) over every kind and type the
 * schema allows, plus NULL and an unknown value.
 */

/** One `.or()` group of the shape `col.is.null,col.not.in.(a,b)`, evaluated. */
function evalGroup(group: string, row: Record<string, string | null>): boolean {
  const m = /^(\w+)\.is\.null,(\w+)\.not\.in\.\(([^)]*)\)$/.exec(group);
  if (!m || m[1] !== m[2]) throw new Error(`unexpected filter shape: ${group}`);
  const value = row[m[1]!] ?? null;
  if (value === null) return true;
  return !m[3]!.split(',').includes(value);
}

const KINDS = [null, ...SYSTEM_KINDS, ...PLACEMENT_KINDS, 'zone'];
const TYPES = [null, 'warehouse', 'room', 'shelf', 'bin', 'vehicle', 'jobsite', 'other', 'dock'];

describe('the phone location filter offers exactly the sites core names', () => {
  it.each(KINDS.flatMap((kind) => TYPES.map((type) => [kind, type] as const)))(
    'kind %s, type %s',
    (kind, type) => {
      const row = { kind, type };
      const kept = evalGroup(SITE_KIND_FILTER, row) && evalGroup(SITE_TYPE_FILTER, row);
      expect(kept).toBe(isSiteLocation(row));
    },
  );

  it('offers a site of type "other" and never an area typed as a room (the old type list did the reverse)', () => {
    const other = { kind: null, type: 'other' };
    const area = { kind: 'area', type: 'room' };
    expect(evalGroup(SITE_KIND_FILTER, other) && evalGroup(SITE_TYPE_FILTER, other)).toBe(true);
    expect(evalGroup(SITE_KIND_FILTER, area) && evalGroup(SITE_TYPE_FILTER, area)).toBe(false);
  });

  it('applies both groups to the read, in one call each', () => {
    const calls: string[] = [];
    const q = {
      or(filters: string) {
        calls.push(filters);
        return q;
      },
    };
    expect(onlySiteLocations(q)).toBe(q);
    expect(calls).toEqual([SITE_KIND_FILTER, SITE_TYPE_FILTER]);
  });

  it('is built from the shared lists, not a copy', () => {
    for (const k of [...SYSTEM_KINDS, ...PLACEMENT_KINDS]) expect(SITE_KIND_FILTER).toContain(k);
    for (const t of PLACEMENT_TYPES) expect(SITE_TYPE_FILTER).toContain(t);
  });
});
