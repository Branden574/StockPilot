/**
 * PostgREST relationship model for the public schema.
 *
 * WHY THIS EXISTS. When two tables are joined by more than one relationship,
 * a PostgREST embed that does not name one fails the whole request with HTTP
 * 300, code PGRST201 ("Could not embed because more than one relationship
 * was found"). The weekly digest cron embedded `organization_members` from
 * `user_profiles` without a hint; organization_members has two foreign keys
 * to user_profiles (user_id, invited_by), so the cron answered 500 every
 * Monday and never sent a digest. Nothing reported it, because a cron has no
 * user to complain.
 *
 * This module turns a catalog census (scripts/postgrest-embeds/census.sql)
 * into the relationships PostgREST sees, with the same rules PostgREST uses
 * (verified against the local stack's PostgREST 14, 2026-10-05):
 *
 *   - every foreign key between two public tables is one relationship, seen
 *     from both ends (many-to-one from the referencing table, one-to-many
 *     from the referenced one);
 *   - a junction table J gives one many-to-many relationship between A and B
 *     for each pair of distinct foreign keys J -> A and J -> B whose columns
 *     are all part of J's PRIMARY KEY (a unique constraint is not enough);
 *   - a self-referencing foreign key alone is NOT ambiguous: PostgREST
 *     resolves `locations(...)` embedded from `locations` (200). A table
 *     with two or more self relationships is treated as ambiguous. A self
 *     embed may be named only by its column (`locations!parent_id`,
 *     `parent:parent_id`); the constraint name answers PGRST200.
 *
 * Two tables are an AMBIGUOUS PAIR when two or more relationships join them.
 * Every embed between an ambiguous pair must name its relationship, with a
 * hint (`user_profiles!orders_requested_by_fkey(...)`, a foreign key column
 * `user_profiles!requested_by(...)`, or a junction table name) or by
 * embedding through the foreign key column (`requester:requested_by(...)`).
 *
 * Plain ESM with no dependencies, so the generator script, the sweep and the
 * vitest guard (apps/web/src/test/postgrest-embeds.guard.test.ts) all load
 * the same rules.
 */

/**
 * @typedef {[table: string, name: string, refTable: string, columns: string[], refColumns: string[]]} CensusFk
 * @typedef {{ fks: CensusFk[], pks: Record<string, string[]>, views?: string[] }} Census
 * @typedef {{ kind: 'fk', name: string, table: string, columns: string[], refTable: string, refColumns: string[] }} FkRelationship
 * @typedef {{ kind: 'junction', name: string, a: string, aFk: string, b: string, bFk: string }} JunctionRelationship
 * @typedef {FkRelationship | JunctionRelationship} Relationship
 */

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The unordered key of a table pair: `a|b` with a <= b. */
export function pairKey(a, b) {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The relationships between every pair of public tables.
 * @param {Census} census
 */
export function buildRelationshipModel(census) {
  /** @type {FkRelationship[]} */
  const fks = census.fks
    .map(([table, name, refTable, columns, refColumns]) => ({
      kind: /** @type {const} */ ('fk'),
      name,
      table,
      columns: [...columns],
      refTable,
      refColumns: [...refColumns],
    }))
    .sort((x, y) => byText(x.table, y.table) || byText(x.name, y.name));

  /** @type {JunctionRelationship[]} */
  const junctions = [];
  const fksByTable = new Map();
  for (const fk of fks) {
    if (!fksByTable.has(fk.table)) fksByTable.set(fk.table, []);
    fksByTable.get(fk.table).push(fk);
  }
  for (const [table, own] of fksByTable) {
    const pk = new Set(census.pks[table] ?? []);
    if (pk.size === 0) continue;
    for (let i = 0; i < own.length; i += 1) {
      for (let j = i + 1; j < own.length; j += 1) {
        const x = own[i];
        const y = own[j];
        if (![...x.columns, ...y.columns].every((c) => pk.has(c))) continue;
        // One relationship per unordered pair of foreign keys (PostgREST adds
        // it from both ends, A -> B and B -> A).
        const [first, second] = byText(x.refTable, y.refTable) <= 0 ? [x, y] : [y, x];
        junctions.push({
          kind: 'junction',
          name: table,
          a: first.refTable,
          aFk: first.name,
          b: second.refTable,
          bFk: second.name,
        });
      }
    }
  }

  /** @type {Map<string, Relationship[]>} pairKey -> relationships */
  const byPair = new Map();
  const add = (key, rel) => {
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(rel);
  };
  for (const fk of fks) add(pairKey(fk.table, fk.refTable), fk);
  for (const j of junctions) add(pairKey(j.a, j.b), j);

  /** Single-column foreign keys by table and column: the targets of a
   *  column-based embed such as `requester:requested_by(...)`. */
  /** @type {Map<string, Map<string, FkRelationship>>} */
  const fkByColumn = new Map();
  for (const fk of fks) {
    if (fk.columns.length !== 1) continue;
    if (!fkByColumn.has(fk.table)) fkByColumn.set(fk.table, new Map());
    fkByColumn.get(fk.table).set(fk.columns[0], fk);
  }

  const tables = new Set([
    ...Object.keys(census.pks),
    ...fks.flatMap((f) => [f.table, f.refTable]),
  ]);
  const views = new Set(census.views ?? []);

  /** Relationships PostgREST considers when `target` is embedded from `origin`. */
  function relationshipsBetween(origin, target) {
    return byPair.get(pairKey(origin, target)) ?? [];
  }

  function isAmbiguous(origin, target) {
    return relationshipsBetween(origin, target).length >= 2;
  }

  /** The hints PostgREST offers for a pair, as it prints them. */
  function hintsFor(origin, target) {
    return relationshipsBetween(origin, target).map((r) => r.name);
  }

  /**
   * The relationships `hint` selects when `target` is embedded from
   * `origin` (one is what an embed needs). PostgREST accepts a foreign key
   * constraint name, a foreign key column (on either end of a single-column
   * key) or a junction table name. A table embedding ITSELF is narrower:
   * only the referencing column works (`locations!parent_id`); the
   * constraint name and the referenced column answer PGRST200 (PostgREST
   * 14, checked 2026-10-05).
   */
  function hintMatches(origin, target, hint) {
    const rels = relationshipsBetween(origin, target);
    const self = origin === target;
    const matching = rels.filter((r) => {
      if (r.kind === 'junction') return r.name === hint;
      if (self) return r.columns.length === 1 && r.columns[0] === hint;
      if (r.name === hint) return true;
      if (r.columns.length === 1 && (r.columns[0] === hint || r.refColumns[0] === hint))
        return true;
      return false;
    });
    return matching;
  }

  /** The foreign key a column-based embed (`alias:fk_column(...)`) follows. */
  function fkForColumn(table, column) {
    return fkByColumn.get(table)?.get(column) ?? null;
  }

  const fkByName = new Map(fks.map((f) => [f.name, f]));

  /**
   * How PostgREST answers an embed of `target` (with `hints`) from `parent`:
   *   { status: 'ok', table }           one relationship; `table` is what the
   *                                     embed returns (its children's parent)
   *   { status: 'ambiguous', candidates }  PGRST201, HTTP 300
   *   { status: 'no-relationship' }     PGRST200, HTTP 400
   *   { status: 'unchecked', reason }   a view, or a part the scanner could
   *                                     not resolve
   * `isOpaque(name)` says a name stands for an unresolved expression.
   */
  function resolveEmbed(parent, target, hints, isOpaque = () => false) {
    const hint = hints[0] ?? null;
    if (isOpaque(parent) || isOpaque(target)) return { status: 'unchecked', reason: 'not static' };
    if (views.has(parent) || views.has(target)) return { status: 'unchecked', reason: 'view' };
    if (tables.has(target)) {
      if (hint === null) {
        const rels = relationshipsBetween(parent, target);
        if (rels.length === 0) return { status: 'no-relationship' };
        if (rels.length === 1) return { status: 'ok', table: target };
        return { status: 'ambiguous', candidates: rels.map((r) => r.name) };
      }
      if (isOpaque(hint)) return { status: 'unchecked', reason: 'hint not static' };
      const matching = hintMatches(parent, target, hint);
      if (matching.length === 1) return { status: 'ok', table: target };
      if (matching.length === 0) return { status: 'no-relationship' };
      return { status: 'ambiguous', candidates: matching.map((r) => r.name) };
    }
    // `alias:fk_column(...)`: many-to-one through the parent's own column.
    const fk = fkForColumn(parent, target);
    if (fk) return { status: 'ok', table: fk.refTable };
    // A foreign key constraint name as the target (PostgREST accepts it from
    // either end, but not for a self-referencing key).
    const byName = fkByName.get(target);
    if (
      byName &&
      byName.table !== byName.refTable &&
      (byName.table === parent || byName.refTable === parent)
    ) {
      return { status: 'ok', table: byName.table === parent ? byName.refTable : byName.table };
    }
    return { status: 'no-relationship' };
  }

  /** Every unordered pair joined by two or more relationships, sorted. */
  function ambiguousPairs() {
    return [...byPair.entries()]
      .filter(([, rels]) => rels.length >= 2)
      .map(([key, rels]) => {
        const [a, b] = key.split('|');
        return {
          a,
          b,
          relationships: rels
            .map((r) =>
              r.kind === 'junction'
                ? { kind: 'junction', name: r.name, via: [r.aFk, r.bFk] }
                : { kind: 'fk', name: r.name, from: r.table, columns: r.columns, to: r.refTable },
            )
            .sort((x, y) => byText(x.name, y.name)),
        };
      })
      .sort((x, y) => byText(x.a, y.a) || byText(x.b, y.b));
  }

  return {
    fks,
    junctions,
    tables,
    views,
    relationshipsBetween,
    isAmbiguous,
    hintsFor,
    hintMatches,
    fkForColumn,
    resolveEmbed,
    ambiguousPairs,
  };
}
