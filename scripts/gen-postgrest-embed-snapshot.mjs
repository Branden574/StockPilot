#!/usr/bin/env node
/**
 * Regenerate the PostgREST relationship snapshot and the pgTAP block that
 * holds the database to it.
 *
 * WHY. PostgREST refuses an embed between two tables joined by more than one
 * relationship unless the embed names one (HTTP 300, PGRST201). The weekly
 * digest cron failed that way every Monday for weeks. The static guard
 * apps/web/src/test/postgrest-embeds.guard.test.ts checks every select in
 * web, phone and core against scripts/postgrest-embeds/relationships.snapshot.json,
 * and supabase/tests/postgrest_embed_relationships.test.sql fails when the
 * database no longer matches that snapshot. A migration that adds, drops or
 * renames a foreign key (or changes a junction table's primary key) therefore
 * fails pgTAP until the snapshot is regenerated, and the regenerated snapshot
 * makes the guard check every embed against the new relationships.
 *
 * WHAT IT WRITES
 *   scripts/postgrest-embeds/relationships.snapshot.json
 *       every public foreign key, the primary keys and views, the junctions
 *       PostgREST sees and the ambiguous pairs (relationships.mjs has the rules)
 *   supabase/tests/postgrest_embed_relationships.test.sql
 *       the block between the GENERATED markers: the same facts as rows
 *
 * USAGE
 *   node scripts/gen-postgrest-embed-snapshot.mjs
 *       read the LOCAL database (after `pnpm exec supabase db reset` or
 *       `start`): SUPABASE_DB_URL, --db-url, or the stack's default
 *       postgresql://postgres:postgres@127.0.0.1:54322/postgres. Needs psql.
 *       Refuses any host that is not local.
 *   node scripts/gen-postgrest-embed-snapshot.mjs --census <file.json>
 *       build from a saved census instead: the output of
 *       scripts/postgrest-embeds/census.sql, run anywhere read-only (that is
 *       how the first snapshot was made, from production, 2026-10-05)
 *   node scripts/gen-postgrest-embed-snapshot.mjs --print-sql
 *       print the census query
 *   node scripts/gen-postgrest-embed-snapshot.mjs --check
 *       write nothing; exit 1 when the snapshot does not follow from its own
 *       foreign keys or the pgTAP block is stale (the guard runs the same
 *       check in vitest)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildRelationshipModel } from './postgrest-embeds/relationships.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = path.join(
  ROOT,
  'scripts/postgrest-embeds/relationships.snapshot.json',
);
export const CENSUS_SQL_PATH = path.join(ROOT, 'scripts/postgrest-embeds/census.sql');
export const PGTAP_PATH = path.join(ROOT, 'supabase/tests/postgrest_embed_relationships.test.sql');
export const BEGIN_MARKER =
  '-- BEGIN GENERATED: scripts/gen-postgrest-embed-snapshot.mjs from scripts/postgrest-embeds/relationships.snapshot.json. Do not edit by hand.';
export const END_MARKER = '-- END GENERATED';
const DEFAULT_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The snapshot for a census.
 * @param {{ fks: Array<[string, string, string, string[], string[]]>, pks: Record<string, string[]>, views?: string[] }} census
 * @param {string} source where the census came from
 */
export function buildSnapshot(census, source) {
  const model = buildRelationshipModel(census);
  const pks = Object.fromEntries(Object.entries(census.pks).sort(([a], [b]) => byText(a, b)));
  return {
    generatedBy: 'scripts/gen-postgrest-embed-snapshot.mjs (do not edit by hand)',
    source,
    foreignKeys: model.fks.map((f) => [f.table, f.name, f.refTable, f.columns, f.refColumns]),
    primaryKeys: pks,
    views: [...(census.views ?? [])].sort(byText),
    junctions: model.junctions
      .map((j) => ({ junction: j.name, a: j.a, b: j.b, via: [j.aFk, j.bFk] }))
      .sort(
        (x, y) =>
          byText(x.junction, y.junction) ||
          byText(x.via[0], y.via[0]) ||
          byText(x.via[1], y.via[1]),
      ),
    ambiguousPairs: model.ambiguousPairs().map((p) => ({
      a: p.a,
      b: p.b,
      relationships: p.relationships.map((r) => r.name),
    })),
  };
}

/** The census a snapshot was built from (to rebuild its model). */
export function snapshotCensus(snapshot) {
  return { fks: snapshot.foreignKeys, pks: snapshot.primaryKeys, views: snapshot.views };
}

/** One value per line where it helps a diff; prettier leaves the file alone
 *  (.prettierignore). */
export function serializeSnapshot(s) {
  const j = (v) => JSON.stringify(v);
  const list = (items) =>
    items.length === 0 ? '[]' : `[\n${items.map((x) => `    ${j(x)}`).join(',\n')}\n  ]`;
  const pkLines = Object.entries(s.primaryKeys).map(([t, cols]) => `    ${j(t)}: ${j(cols)}`);
  return `${[
    '{',
    `  "generatedBy": ${j(s.generatedBy)},`,
    `  "source": ${j(s.source)},`,
    `  "foreignKeys": ${list(s.foreignKeys)},`,
    `  "primaryKeys": {\n${pkLines.join(',\n')}\n  },`,
    `  "views": ${j(s.views)},`,
    `  "junctions": ${list(s.junctions)},`,
    `  "ambiguousPairs": ${list(s.ambiguousPairs)}`,
    '}',
  ].join('\n')}\n`;
}

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** The pgTAP data block: the snapshot's facts as rows. */
export function renderPgtapBlock(s) {
  // An empty list inserts nothing (`values` with no rows is a syntax error).
  const insert = (head, items) =>
    items.length === 0
      ? [`-- (no rows for: ${head})`]
      : [`${head} values`, `${items.map((r) => `  (${r.map(sqlText).join(', ')})`).join(',\n')};`];
  const fkRows = s.foreignKeys.map(([t, n, r, c, rc]) => [t, n, r, c.join(','), rc.join(',')]);
  const junctionRows = s.junctions.map((x) => [x.junction, x.a, x.b, x.via[0], x.via[1]]);
  const pairRows = s.ambiguousPairs.map((p) => [p.a, p.b, p.relationships.join(',')]);
  return [
    BEGIN_MARKER,
    `-- ${s.foreignKeys.length} foreign keys, ${s.junctions.length} junctions, ${s.ambiguousPairs.length} ambiguous pairs.`,
    ...insert('insert into expected_fks (tbl, name, ref_tbl, cols, ref_cols)', fkRows),
    ...insert('insert into expected_junctions (junction, a, b, a_fk, b_fk)', junctionRows),
    ...insert('insert into expected_pairs (a, b, relationships)', pairRows),
    END_MARKER,
  ].join('\n');
}

/** The block currently in the pgTAP file, or null when its markers are wrong. */
export function currentPgtapBlock(text) {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER, begin);
  if (begin < 0 || end < 0) return null;
  return text.slice(begin, end + END_MARKER.length);
}

/** Problems with the committed snapshot and pgTAP block; [] when current. */
export function checkCommitted() {
  const problems = [];
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  const rebuilt = buildSnapshot(snapshotCensus(snapshot), snapshot.source);
  for (const key of ['foreignKeys', 'junctions', 'ambiguousPairs']) {
    if (JSON.stringify(rebuilt[key]) !== JSON.stringify(snapshot[key])) {
      problems.push(
        `${path.relative(ROOT, SNAPSHOT_PATH)}: "${key}" does not follow from its foreign keys and primary keys (edited by hand?)`,
      );
    }
  }
  const pgtap = readFileSync(PGTAP_PATH, 'utf8');
  const block = currentPgtapBlock(pgtap);
  if (block === null)
    problems.push(`${path.relative(ROOT, PGTAP_PATH)}: GENERATED markers not found`);
  else if (block !== renderPgtapBlock(snapshot)) {
    problems.push(
      `${path.relative(ROOT, PGTAP_PATH)}: the GENERATED block is stale; run node scripts/gen-postgrest-embed-snapshot.mjs --census <census> or against the local stack`,
    );
  }
  return problems;
}

function isLocalDbUrl(url) {
  try {
    const u = new URL(url);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function readCensusFromDb(url) {
  if (!isLocalDbUrl(url)) {
    throw new Error(
      'refusing a database that is not local. Run scripts/postgrest-embeds/census.sql read-only there, save the JSON and pass --census <file>.',
    );
  }
  const out = execFileSync(
    'psql',
    [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-f', CENSUS_SQL_PATH],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return JSON.parse(out.trim());
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--print-sql')) {
    process.stdout.write(readFileSync(CENSUS_SQL_PATH, 'utf8'));
    return 0;
  }
  if (argv.includes('--check')) {
    const problems = checkCommitted();
    for (const p of problems) console.error(p);
    if (problems.length === 0) console.log('snapshot and pgTAP block are current');
    return problems.length === 0 ? 0 : 1;
  }
  let census;
  let source;
  const censusFile = arg('--census');
  if (censusFile) {
    census = JSON.parse(readFileSync(censusFile, 'utf8'));
    source = census.source ?? `census file ${path.basename(censusFile)}`;
  } else {
    const url = arg('--db-url') ?? process.env.SUPABASE_DB_URL ?? DEFAULT_DB_URL;
    census = readCensusFromDb(url);
    source = `local database catalog (scripts/postgrest-embeds/census.sql), ${new Date().toISOString().slice(0, 10)}`;
  }
  const snapshot = buildSnapshot(census, source);
  writeFileSync(SNAPSHOT_PATH, serializeSnapshot(snapshot));
  const pgtap = readFileSync(PGTAP_PATH, 'utf8');
  const block = currentPgtapBlock(pgtap);
  if (block === null) throw new Error(`${PGTAP_PATH}: GENERATED markers not found`);
  writeFileSync(PGTAP_PATH, pgtap.replace(block, renderPgtapBlock(snapshot)));
  console.log(
    `wrote ${path.relative(ROOT, SNAPSHOT_PATH)} (${snapshot.foreignKeys.length} foreign keys, ${snapshot.junctions.length} junctions, ${snapshot.ambiguousPairs.length} ambiguous pairs) and the pgTAP block`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  }
}
