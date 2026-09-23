import { describe, expect, it } from 'vitest';

import { classifyInFilterSites } from './in-filter-sites';

/**
 * The classifier behind the in-filter-sites guard. Each fixture is a tiny
 * source file; what matters is which `.in()` sites it counts and which it
 * exempts, and why.
 */

const HELPER_IMPORT = "import { fetchAllRowsByIds } from './lib/fetch-by-ids';\n";

function counted(text: string, file = 'x.ts') {
  return classifyInFilterSites(file, text).filter((s) => s.exempt === null);
}

describe('classifyInFilterSites', () => {
  it('exempts an array literal of plain literals', () => {
    const sites = classifyInFilterSites('x.ts', "q.in('status', ['a', 'b', 1, true]);");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.exempt).toBe('literal-array');
  });

  it('counts an array literal that spreads a collection', () => {
    expect(counted("q.in('id', [...assignedIds]);")).toHaveLength(1);
    expect(counted("q.in('id', [first, ...rest]);")).toHaveLength(1);
  });

  it('exempts a SCREAMING_CASE constant and counts a camelCase variable', () => {
    expect(
      classifyInFilterSites('x.ts', "q.in('permission', AUDIENCE_PERMISSIONS);")[0]?.exempt,
    ).toBe('constant');
    expect(counted("q.in('id', itemIds);")).toHaveLength(1);
  });

  it('exempts `batch` only in a file that imports the batching helpers', () => {
    const text = "q.in('id', batch);";
    expect(counted(text)).toHaveLength(1);
    expect(classifyInFilterSites('x.ts', HELPER_IMPORT + text)[0]?.exempt).toBe('batch');
    const viaInFilter = "import { chunkInFilterValues } from '@/lib/supabase/in-filter';\n" + text;
    expect(classifyInFilterSites('x.ts', viaInFilter)[0]?.exempt).toBe('batch');
  });

  it('exempts a call annotated on its line or up to three lines above, with a real reason', () => {
    expect(
      classifyInFilterSites(
        'x.ts',
        "// in-list-bound: the org's readable warehouses\nq.in('warehouse_id', ids);",
      )[0]?.exempt,
    ).toBe('annotated');
    expect(
      classifyInFilterSites(
        'x.ts',
        "// in-list-bound: a handful of sites\n\n\n\nq.in('warehouse_id', ids);",
      )[0]?.exempt,
    ).toBeNull();
    // Too short to be a reason.
    expect(counted("// in-list-bound: ok\nq.in('id', ids);")).toHaveLength(1);
  });

  it('finds a call split over several lines and reports the line of `.in`', () => {
    const text = [
      'const r = await q',
      "  .from('t')",
      '  .in(',
      "    'id',",
      '    rows.map((r) => r.id),',
      '  );',
    ].join('\n');
    const sites = classifyInFilterSites('x.ts', text);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.line).toBe(3);
    expect(sites[0]?.fingerprint).toBe('in:id <- rows.map((r) => r.id)');
  });

  it('counts an `in.(${…})` filter string and exempts one built from `batch`', () => {
    const text = 'q.or(`vendor_id.in.(${supplierIds.join(",")}),x.eq.1`);';
    const sites = classifyInFilterSites('x.ts', text);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe('template');
    expect(sites[0]?.exempt).toBeNull();
    const batched = HELPER_IMPORT + 'q.or(`vendor_id.in.(${batch.join(",")})`);';
    expect(classifyInFilterSites('x.ts', batched)[0]?.exempt).toBe('batch');
  });

  it('handles notIn and TSX files', () => {
    expect(counted("q.notIn('id', ids);")[0]?.kind).toBe('notIn');
    expect(counted("const el = <div>{q.in('id', ids) && 1}</div>;", 'x.tsx')).toHaveLength(1);
  });

  it('ignores `.in` calls whose first argument is not a string literal', () => {
    expect(classifyInFilterSites('x.ts', 'set.in(column, values);')).toEqual([]);
  });

  it('fingerprints stay the same when the code moves', () => {
    const a = classifyInFilterSites('x.ts', "q.in('id', itemIds);")[0]?.fingerprint;
    const b = classifyInFilterSites('x.ts', "\n\n\nconst z = 1;\nq.in('id',   itemIds);")[0]
      ?.fingerprint;
    expect(a).toBe(b);
  });
});
