import { describe, expect, it } from 'vitest';

import { classifyInFilterSites, mayHoldInFilter } from './in-filter-sites';

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
    const text = "await fetchAllRowsByIds(ids, (batch) => q.in('id', batch));";
    expect(counted(text)).toHaveLength(1);
    expect(classifyInFilterSites('x.ts', HELPER_IMPORT + text)[0]?.exempt).toBe('batch');
    const loop = "for (const batch of chunkInFilterValues(ids)) await q.in('id', batch);";
    expect(counted(loop)).toHaveLength(1);
    const viaInFilter = "import { chunkInFilterValues } from '@/lib/supabase/in-filter';\n" + loop;
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
    const batched =
      HELPER_IMPORT +
      'await mapIdBatches(ids, (batch) => q.or(`vendor_id.in.(${batch.join(",")})`));';
    expect(classifyInFilterSites('x.ts', batched)[0]?.exempt).toBe('batch');
  });

  it('handles notIn and TSX files', () => {
    expect(counted("q.notIn('id', ids);")[0]?.kind).toBe('notIn');
    expect(counted("const el = <div>{q.in('id', ids) && 1}</div>;", 'x.tsx')).toHaveLength(1);
  });

  it('counts `.in` with a column that is not a string literal', () => {
    const sites = counted('q.in(column, ids);');
    expect(sites).toHaveLength(1);
    expect(sites[0]?.fingerprint).toBe('in:column <- ids');
    // Its values are still classified like any other site.
    expect(classifyInFilterSites('x.ts', "q.in(column, ['a', 'b']);")[0]?.exempt).toBe(
      'literal-array',
    );
  });

  it("counts `.filter(col, 'in', …)` and `.not(col, 'in', …)` built from a variable", () => {
    const filter = counted("q.filter('id', 'in', `(${ids.join(',')})`);");
    expect(filter).toHaveLength(1);
    expect(filter[0]?.kind).toBe('filter');
    expect(filter[0]?.fingerprint).toBe("filter:id <- `(${ids.join(',')})`");
    const not = counted("q.not('id', 'in', '(' + ids.join(',') + ')');");
    expect(not).toHaveLength(1);
    expect(not[0]?.kind).toBe('not');
  });

  it("exempts `.filter` / `.not` 'in' lists that are literal or built from a constant", () => {
    expect(
      classifyInFilterSites('x.ts', "q.not('status', 'in', '(failed,canceled)');")[0]?.exempt,
    ).toBe('literal-array');
    expect(
      classifyInFilterSites('x.ts', "q.not('event', 'in', `(${SHADOWED.join(',')})`);")[0]?.exempt,
    ).toBe('constant');
    // Other operators are not id lists.
    expect(classifyInFilterSites('x.ts', "q.filter('name', 'ilike', `%${term}%`);")).toEqual([]);
    expect(classifyInFilterSites('x.ts', "q.not('id', 'is', null);")).toEqual([]);
  });

  it('counts an `in.(` filter string built by concatenation', () => {
    const sites = counted("q.or('id.in.(' + ids.join(',') + ')');");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe('template');
    expect(sites[0]?.fingerprint).toBe("template:id.in.( <- ids.join(',')");
    expect(counted("q.or(prefix + 'charter_id.in.(' + list + ')');")).toHaveLength(1);
    expect(counted("q.or(`${col}.in.(` + list + ')');")).toHaveLength(1);
    // A constant list stays exempt.
    expect(
      classifyInFilterSites('x.ts', "q.or('id.in.(' + KNOWN.join(',') + ')');")[0]?.exempt,
    ).toBe('constant');
  });

  it('counts an `in.(` filter string built with an array join', () => {
    expect(counted("q.or(['id.in.(', ids.join(','), ')'].join(''));")).toHaveLength(1);
  });

  it("exempts `batch` only as the helper callback's parameter or a chunkInFilterValues loop variable", () => {
    // A local named `batch` is not a batch.
    expect(
      counted(
        HELPER_IMPORT +
          "const batch = ids;\nawait fetchAllRowsByIds(ids, () => q.in('id', batch));",
      ),
    ).toHaveLength(1);
    // A parameter named `batch` of some other function is not one either.
    expect(
      counted(HELPER_IMPORT + "function read(batch: string[]) { return q.in('id', batch); }"),
    ).toHaveLength(1);
    expect(counted(HELPER_IMPORT + "items.forEach((batch) => q.in('id', batch));")).toHaveLength(1);
    // The helper's callback, directly or through a page builder.
    for (const text of [
      "await fetchAllRowsByIds(ids, (batch) => (from, to) => q.in('id', batch).range(from, to));",
      "await mapIdBatches(ids, async (batch) => q.in('id', batch.map((b) => b)));",
      "await writeInIdBatches(ids, function (batch) { return q.in('id', batch); });",
      "for (const batch of chunkInFilterValues(ids)) await q.in('id', batch);",
    ]) {
      expect(classifyInFilterSites('x.ts', HELPER_IMPORT + text)[0]?.exempt, text).toBe('batch');
    }
    // The nearest binding wins: a shadowing local inside the callback counts.
    expect(
      counted(
        HELPER_IMPORT +
          "await mapIdBatches(ids, async (batch) => { const batch2 = 1; { const batch = all; return q.in('id', batch); } });",
      ),
    ).toHaveLength(1);
  });

  it('fingerprints stay the same when the code moves', () => {
    const a = classifyInFilterSites('x.ts', "q.in('id', itemIds);")[0]?.fingerprint;
    const b = classifyInFilterSites('x.ts', "\n\n\nconst z = 1;\nq.in('id',   itemIds);")[0]
      ?.fingerprint;
    expect(a).toBe(b);
  });

  it('the pre-parse check lets through every shape, including `.filter`/`.not` with `in`', () => {
    for (const text of [
      "q.in('id', ids);",
      "q.notIn('id', ids);",
      'q.or(`id.in.(${ids})`);',
      "q.or('id.in.(' + ids + ')');",
      "q.not('id', 'in', list);",
      'q.filter("id", "in", list);',
    ]) {
      expect(mayHoldInFilter(text), text).toBe(true);
    }
    expect(mayHoldInFilter("const x = items.includes('a');")).toBe(false);
  });
});
