#!/usr/bin/env node
/**
 * Write the GRANT statements that restate, object by object, the privileges
 * the Data API roles (anon, authenticated, service_role) hold on every public
 * table, view, materialized view, foreign table and sequence, table-level and
 * column-level.
 *
 * WHY. On 2026-10-30 Supabase stops granting those roles access to NEW
 * tables, views and sequences in public (changelog 45329): it revokes the
 * `postgres` role's default privileges there. A database built from our
 * migrations after that, or with a CLI that applies the same defaults, gets
 * only the privileges a migration grants by name. Migration 0402 restates
 * every privilege production held on 2026-10-24, so what the migration chain
 * ends with no longer depends on the defaults (0402's header lists what still
 * does). Never replace it with `grant ... on all tables`: that would undo the
 * migrations' REVOKEs and the column-level grants.
 *
 * WHAT IT WRITES
 *   the block between the GENERATED markers of the migration (default
 *   supabase/migrations/0402_explicit_data_api_grants.sql, or --out <file>).
 *   Everything outside the markers (the header) is kept. A file that does not
 *   exist yet gets a stub header to complete by hand. The block holds only
 *   GRANT statements, one group per relation, sorted by name: no REVOKE and no
 *   DDL, so applying it twice changes nothing.
 *
 * WHERE THE PRIVILEGES COME FROM: a census, the JSON printed by
 * scripts/explicit-grants/census.sql (one read-only SELECT).
 *
 * AFTER 0402: THE REVOKES OF 0407. Migration 0407 (docket S9, slice 4.3)
 * takes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN away from anon and
 * authenticated on every public relation, and out of the postgres role's
 * default privileges in public, so neither role holds them afterwards (pgTAP
 * security_invariants INV-42 and INV-43). 0402's block still grants them,
 * because it restates 2026-10-24, and a migration that has been pushed is
 * never edited. So from 0407 on:
 *   - 0402's --check describes 0402 alone. Against a database at 0407 or
 *     later it reports every relation 0407 changed (and every relation a
 *     later migration created); that is expected, not drift.
 *   - --revokes writes and checks 0407's own GENERATED block: one REVOKE per
 *     relation on which anon or authenticated holds any of the four. Before
 *     0407 is pushed, --revokes --check with a fresh production census proves
 *     the block names exactly the relations production would lose them on.
 *     After the push the census gives an empty block, so --check then fails
 *     by design: the post-push proof is that no relation is listed (the
 *     "relations" count in the empty block's header is 0).
 *   - --compare tells whether two censuses hold the same privileges, and
 *     lists every difference. Production against a scratch database built
 *     from the whole migration chain (--db-url there, or its census) is the
 *     check that holds for any later state; production before and after a
 *     push shows exactly what the push changed.
 *
 * USAGE
 *   psql "<production url>" -X -A -t -q -f scripts/explicit-grants/census.sql > census.json
 *       take the census read-only from production (or from a scratch database
 *       loaded from `supabase db dump --schema public`; that is how 0402 was made)
 *   node scripts/gen-explicit-grants-sql.mjs --census census.json [--out <file>]
 *       rewrite the GENERATED block from that census
 *   node scripts/gen-explicit-grants-sql.mjs --db-url <url> [--out <file>]
 *       take the census from a LOCAL database (refuses any other host)
 *   node scripts/gen-explicit-grants-sql.mjs --census census.json --check [--out <file>]
 *       write nothing; exit 1 when the block differs from what the census
 *       gives (run it with a fresh production census before pushing 0402)
 *   node scripts/gen-explicit-grants-sql.mjs --revokes (--census census.json | --db-url <url>) [--check] [--out <file>]
 *       the same for 0407's REVOKE block (default --out: the one migration
 *       named *_grants_policy_cleanup.sql, whatever its number after a rebase)
 *   node scripts/gen-explicit-grants-sql.mjs --compare <a.json> <b.json>
 *       write nothing; print every privilege one census holds and the other
 *       does not; exit 0 when they hold the same, 1 when they differ
 *   node scripts/gen-explicit-grants-sql.mjs --print-sql
 *       print the census query
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATION_PATH = path.join(
  ROOT,
  'supabase/migrations/0402_explicit_data_api_grants.sql',
);
export const CENSUS_SQL_PATH = path.join(ROOT, 'scripts/explicit-grants/census.sql');
export const BEGIN_MARKER =
  '-- BEGIN GENERATED: scripts/gen-explicit-grants-sql.mjs from a census (scripts/explicit-grants/census.sql). Do not edit by hand.';
export const END_MARKER = '-- END GENERATED';

/** 0407's block: its own markers, so neither mode can read the other's block. */
export const REVOKES_BEGIN_MARKER =
  '-- BEGIN GENERATED REVOKES: scripts/gen-explicit-grants-sql.mjs --revokes from a census (scripts/explicit-grants/census.sql). Do not edit by hand.';
export const REVOKES_END_MARKER = '-- END GENERATED REVOKES';
/** The migration that carries the REVOKE block, found by name so a renumber keeps working. */
export const REVOKES_MIGRATION_SUFFIX = '_grants_policy_cleanup.sql';

/** The Data API roles, in the order statements name them. */
export const ROLES = ['anon', 'authenticated', 'service_role'];

/**
 * What 0407 takes away: these table privileges, from these roles, on every
 * public relation (and out of the postgres role's default privileges there).
 * None of them is ever used through the Data API; TRUNCATE skips row level
 * security altogether.
 */
export const CLIENT_ROLES = ['anon', 'authenticated'];
export const DDL_PRIVILEGES = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];

const KINDS = {
  r: { word: 'table', target: 'table' },
  p: { word: 'partitioned table', target: 'table' },
  v: { word: 'view', target: 'table' },
  m: { word: 'materialized view', target: 'table' },
  f: { word: 'foreign table', target: 'table' },
  S: { word: 'sequence', target: 'sequence' },
};
/** Privileges in the order GRANT documents them. */
const RELATION_PRIVILEGES = {
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
};
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const LINE = 100;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const roleOrder = (a, b) => ROLES.indexOf(a) - ROLES.indexOf(b);

function fail(message) {
  throw new Error(`census: ${message}`);
}

/** Checks the census has the shape census.sql prints; throws on anything unexpected. */
export function validateCensus(census) {
  if (!census || !Array.isArray(census.relations)) fail('no "relations" array');
  const roles = [...(census.roles ?? [])].sort(roleOrder);
  if (JSON.stringify(roles) !== JSON.stringify(ROLES)) {
    fail(`"roles" must be ${ROLES.join(', ')} (got ${JSON.stringify(census.roles)})`);
  }
  if (census.relations.length === 0) fail('no relations');
  const seen = new Set();
  for (const rel of census.relations) {
    const kind = KINDS[rel.kind];
    if (!kind) fail(`${rel.name}: unknown relkind ${JSON.stringify(rel.kind)}`);
    if (typeof rel.name !== 'string' || typeof rel.ident !== 'string' || !rel.ident) {
      fail(`relation without a name or identifier: ${JSON.stringify(rel)}`);
    }
    if (seen.has(rel.name)) fail(`${rel.name} listed twice`);
    seen.add(rel.name);
    for (const [role, privilege, grantable] of rel.privileges) {
      if (!ROLES.includes(role)) fail(`${rel.name}: unexpected role ${role}`);
      if (!RELATION_PRIVILEGES[kind.target].includes(privilege)) {
        fail(`${rel.name}: unexpected ${kind.word} privilege ${privilege}`);
      }
      if (typeof grantable !== 'boolean') fail(`${rel.name}: grant option is not a boolean`);
    }
    for (const [column, ident, role, privilege, grantable] of rel.columns) {
      if (kind.target !== 'table') fail(`${rel.name}: column privileges on a ${kind.word}`);
      if (typeof column !== 'string' || typeof ident !== 'string' || !ident) {
        fail(`${rel.name}: column without a name or identifier`);
      }
      if (!ROLES.includes(role)) fail(`${rel.name}.${column}: unexpected role ${role}`);
      if (!COLUMN_PRIVILEGES.includes(privilege)) {
        fail(`${rel.name}.${column}: unexpected column privilege ${privilege}`);
      }
      if (typeof grantable !== 'boolean') fail(`${rel.name}.${column}: grant option is not a boolean`);
    }
  }
  return census;
}

/** Roles that share an identical key, in role order: [[key, roles[]], ...] by first role. */
function groupRoles(entries) {
  const groups = new Map();
  for (const [role, key] of entries) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(role);
  }
  return [...groups.entries()]
    .map(([key, roles]) => [key, roles.sort(roleOrder)])
    .sort((a, b) => roleOrder(a[1][0], b[1][0]) || byText(a[0], b[0]));
}

/** `grant <head> (<columns>) <tail>;`, the column list wrapped when the line is long. */
function columnStatement(head, idents, tail) {
  const flat = `grant ${head} (${idents.join(', ')}) ${tail};`;
  if (flat.length <= LINE) return [flat];
  const lines = [`grant ${head} (`];
  let line = '   ';
  for (const [i, ident] of idents.entries()) {
    const piece = ` ${ident}${i < idents.length - 1 ? ',' : ''}`;
    if (line.length + piece.length > LINE - 2 && line.trim()) {
      lines.push(line);
      line = '   ';
    }
    line += piece;
  }
  lines.push(line, `  ) ${tail};`);
  return lines;
}

/** The statements for one relation, with its comment line first. */
export function renderRelation(rel) {
  const kind = KINDS[rel.kind];
  const target = `${kind.target} public.${rel.ident}`;
  const label = `-- public.${rel.name} (${kind.word})`;
  const order = RELATION_PRIVILEGES[kind.target];
  const lines = [];

  // Table-level: one statement per set of roles holding the same privileges.
  for (const grantable of [false, true]) {
    const byRole = new Map();
    for (const [role, privilege, g] of rel.privileges) {
      if (g !== grantable) continue;
      if (!byRole.has(role)) byRole.set(role, new Set());
      byRole.get(role).add(privilege);
    }
    const entries = [...byRole.entries()].map(([role, privs]) => [
      role,
      order.filter((p) => privs.has(p)).join(', ').toLowerCase(),
    ]);
    for (const [privs, roles] of groupRoles(entries)) {
      const tail = `on ${target} to ${roles.join(', ')}${grantable ? ' with grant option' : ''};`;
      const flat = `grant ${privs} ${tail}`;
      lines.push(...(flat.length <= LINE ? [flat] : [`grant ${privs}`, `  ${tail}`]));
    }
  }

  // Column-level: one statement per privilege and set of roles granted the same columns.
  for (const grantable of [false, true]) {
    for (const privilege of COLUMN_PRIVILEGES) {
      const byRole = new Map();
      for (const [, ident, role, p, g] of rel.columns) {
        if (p !== privilege || g !== grantable) continue;
        if (!byRole.has(role)) byRole.set(role, []);
        byRole.get(role).push(ident);
      }
      const entries = [...byRole.entries()].map(([role, idents]) => [
        role,
        JSON.stringify([...new Set(idents)].sort(byText)),
      ]);
      for (const [key, roles] of groupRoles(entries)) {
        lines.push(
          ...columnStatement(
            privilege.toLowerCase(),
            JSON.parse(key),
            `on table public.${rel.ident} to ${roles.join(', ')}${grantable ? ' with grant option' : ''}`,
          ),
        );
      }
    }
  }

  if (lines.length === 0) return [`${label}: no privileges for anon, authenticated or service_role.`];
  return [label, ...lines];
}

/** The GENERATED block for a census. */
export function renderGrantsBlock(census) {
  validateCensus(census);
  const relations = [...census.relations].sort((a, b) => byText(a.name, b.name));
  const kinds = {};
  for (const rel of relations) kinds[KINDS[rel.kind].word] = (kinds[KINDS[rel.kind].word] ?? 0) + 1;
  const kindText = Object.entries(kinds)
    .sort((a, b) => byText(a[0], b[0]))
    .map(([word, n]) => `${n} ${word}${n === 1 ? '' : 's'}`)
    .join(', ');
  const relationPrivileges = relations.reduce((n, r) => n + r.privileges.length, 0);
  const columnPrivileges = relations.reduce((n, r) => n + r.columns.length, 0);
  const withNone = relations.filter((r) => r.privileges.length === 0 && r.columns.length === 0);
  const out = [
    BEGIN_MARKER,
    `-- ${relations.length} relations in public (${kindText}).`,
    `-- ${relationPrivileges} table-level and ${columnPrivileges} column-level privileges of anon, authenticated and service_role;`,
    `-- ${withNone.length} relation${withNone.length === 1 ? '' : 's'} where those roles hold none.`,
  ];
  for (const rel of relations) out.push('', ...renderRelation(rel));
  out.push('', END_MARKER);
  return out.join('\n');
}

/**
 * 0407's block: one REVOKE per public relation (sequences aside: the four are
 * table privileges) on which anon or authenticated holds TRUNCATE,
 * REFERENCES, TRIGGER or MAINTAIN, table-level or column-level, sorted by
 * name. Every statement names all four privileges and both roles: revoking a
 * privilege a role does not hold changes nothing, so the statement is the same
 * for every relation, and applying the block twice changes nothing. A REVOKE
 * at table level takes the column-level grants of the same privilege with it.
 */
export function renderRevokesBlock(census) {
  validateCensus(census);
  const relations = [...census.relations].sort((a, b) => byText(a.name, b.name));
  const statements = [];
  let held = 0;
  for (const rel of relations) {
    if (KINDS[rel.kind].target !== 'table') continue;
    const n =
      rel.privileges.filter(([role, p]) => CLIENT_ROLES.includes(role) && DDL_PRIVILEGES.includes(p))
        .length +
      rel.columns.filter(([, , role, p]) => CLIENT_ROLES.includes(role) && DDL_PRIVILEGES.includes(p))
        .length;
    if (n === 0) continue;
    held += n;
    const privs = DDL_PRIVILEGES.join(', ').toLowerCase();
    const tail = `on table public.${rel.ident} from ${CLIENT_ROLES.join(', ')};`;
    const flat = `revoke ${privs} ${tail}`;
    statements.push(...(flat.length <= LINE ? [flat] : [`revoke ${privs}`, `  ${tail}`]));
  }
  const count = statements.filter((l) => l.startsWith('revoke ')).length;
  return [
    REVOKES_BEGIN_MARKER,
    `-- ${count} relation${count === 1 ? '' : 's'} in public on which anon or authenticated hold TRUNCATE, REFERENCES, TRIGGER or MAINTAIN;`,
    `-- ${held} such privilege${held === 1 ? '' : 's'} in all, table-level and column-level.`,
    ...statements,
    REVOKES_END_MARKER,
  ].join('\n');
}

/** The block currently in a migration's text, or null when its markers are missing. */
export function currentBlock(text, begin = BEGIN_MARKER, end = END_MARKER) {
  const from = text.indexOf(begin);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) return null;
  return text.slice(from, to + end.length);
}

/** The one migration named *_grants_policy_cleanup.sql (0407, or its number after a rebase). */
export function revokesMigrationPath(dir = path.join(ROOT, 'supabase/migrations')) {
  const found = readdirSync(dir).filter((f) => f.endsWith(REVOKES_MIGRATION_SUFFIX));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one migration named *${REVOKES_MIGRATION_SUFFIX} in ${dir}, found ${found.length}; pass --out <file>`,
    );
  }
  return path.join(dir, found[0]);
}

/**
 * Every fact a census states, one string each: a relation and its kind, a
 * table-level privilege, a column-level privilege. Grant options are part of
 * the fact. Metadata (when, where, which server) is not.
 */
export function censusFacts(census) {
  validateCensus(census);
  const facts = new Set();
  for (const rel of census.relations) {
    facts.add(`public.${rel.name} is a ${KINDS[rel.kind].word}`);
    for (const [role, privilege, grantable] of rel.privileges) {
      facts.add(`${role} holds ${privilege}${grantable ? ' with grant option' : ''} on public.${rel.name}`);
    }
    for (const [column, , role, privilege, grantable] of rel.columns) {
      facts.add(
        `${role} holds ${privilege}${grantable ? ' with grant option' : ''} on column public.${rel.name}.${column}`,
      );
    }
  }
  return facts;
}

/** The facts only `a` states and the facts only `b` states, each sorted. */
export function compareCensuses(a, b) {
  const fa = censusFacts(a);
  const fb = censusFacts(b);
  return {
    onlyA: [...fa].filter((f) => !fb.has(f)).sort(byText),
    onlyB: [...fb].filter((f) => !fa.has(f)).sort(byText),
  };
}

function stubHeader(file) {
  return [
    `-- ${path.basename(file)}`,
    '--',
    '-- TODO: say why, the date of the census, and how this file was generated',
    '-- (scripts/gen-explicit-grants-sql.mjs; see 0402_explicit_data_api_grants.sql).',
    '',
  ].join('\n');
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
      'refusing a database that is not local. Run scripts/explicit-grants/census.sql read-only there, save the JSON and pass --census <file>.',
    );
  }
  const out = execFileSync(
    'psql',
    [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-f', CENSUS_SQL_PATH],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out.trim());
}

/** The block's paragraphs (the summary, then one per relation), keyed by their first line. */
function paragraphs(block) {
  const out = new Map();
  for (const p of block.split('\n\n')) {
    const key = p.split('\n')[0].replace(/^(-- public\.\S+ \([^)]*\)).*$/, '$1');
    out.set(key, p);
  }
  return out;
}

/** What --check prints: each paragraph that differs, as the file has it and as the census gives it. */
function describeDifferences(fileBlock, censusBlock) {
  const a = paragraphs(fileBlock);
  const b = paragraphs(censusBlock);
  const lines = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) === b.get(key)) continue;
    lines.push(`  ${key}`);
    for (const l of (a.get(key) ?? '(absent)').split('\n')) lines.push(`    file:   ${l}`);
    for (const l of (b.get(key) ?? '(absent)').split('\n')) lines.push(`    census: ${l}`);
  }
  return lines;
}

/** What --revokes --check prints: each statement only one side has. */
function describeRevokeDifferences(fileBlock, censusBlock) {
  const statements = (block) =>
    new Set(
      block
        .replace(/\n {2}on table/g, ' on table')
        .split('\n')
        .filter((l) => l.startsWith('revoke ')),
    );
  const a = statements(fileBlock);
  const b = statements(censusBlock);
  return [
    ...[...a].filter((s) => !b.has(s)).map((s) => `  only in the file:   ${s}`),
    ...[...b].filter((s) => !a.has(s)).map((s) => `  only in the census: ${s}`),
  ];
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
  if (argv.includes('--compare')) {
    const i = argv.indexOf('--compare');
    const [fileA, fileB] = [argv[i + 1], argv[i + 2]];
    if (!fileA || !fileB) throw new Error('pass --compare <a.json> <b.json>');
    const { onlyA, onlyB } = compareCensuses(
      JSON.parse(readFileSync(fileA, 'utf8')),
      JSON.parse(readFileSync(fileB, 'utf8')),
    );
    if (onlyA.length === 0 && onlyB.length === 0) {
      console.log(`${fileA} and ${fileB} hold the same privileges`);
      return 0;
    }
    console.error(`${fileA} and ${fileB} differ: ${onlyA.length} facts only in the first, ${onlyB.length} only in the second`);
    for (const f of onlyA) console.error(`  only in ${fileA}: ${f}`);
    for (const f of onlyB) console.error(`  only in ${fileB}: ${f}`);
    return 1;
  }
  const revokes = argv.includes('--revokes');
  const file = path.resolve(arg('--out') ?? (revokes ? revokesMigrationPath() : MIGRATION_PATH));
  const censusFile = arg('--census');
  const dbUrl = arg('--db-url');
  if (!censusFile && !dbUrl) {
    throw new Error('pass --census <census.json> or --db-url <local url> (see the usage at the top of this file)');
  }
  const census = censusFile ? JSON.parse(readFileSync(censusFile, 'utf8')) : readCensusFromDb(dbUrl);
  const [begin, end] = revokes ? [REVOKES_BEGIN_MARKER, REVOKES_END_MARKER] : [BEGIN_MARKER, END_MARKER];
  const block = revokes ? renderRevokesBlock(census) : renderGrantsBlock(census);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const current = text === null ? null : currentBlock(text, begin, end);
  const what = revokes ? 'GENERATED REVOKES block' : 'GENERATED block';

  if (argv.includes('--check')) {
    if (current === null) {
      console.error(`${path.relative(ROOT, file)}: no ${what}`);
      return 1;
    }
    if (current === block) {
      console.log(`${path.relative(ROOT, file)}: the ${what} matches the census`);
      return 0;
    }
    console.error(`${path.relative(ROOT, file)}: the ${what} differs from the census`);
    const lines = revokes ? describeRevokeDifferences(current, block) : describeDifferences(current, block);
    for (const l of lines) console.error(l);
    return 1;
  }

  if (text !== null && current === null) {
    throw new Error(`${file}: exists but has no ${what} markers; refusing to overwrite it`);
  }
  const next =
    text === null ? `${stubHeader(file)}\n${block}\n` : text.replace(current, () => block);
  writeFileSync(file, next);
  console.log(`wrote the ${what} of ${path.relative(ROOT, file)}`);
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
