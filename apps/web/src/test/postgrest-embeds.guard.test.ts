/**
 * RECURRENCE GUARD: every PostgREST embed between two tables joined by more
 * than one relationship names the one it means.
 *
 * WHAT WENT WRONG. organization_members has two foreign keys to user_profiles
 * (user_id, and invited_by since 0001). PostgREST refuses an embed between two
 * such tables that does not name a relationship: HTTP 300, PGRST201, no rows.
 * The weekly digest cron embedded `organization_members!inner(...)` from
 * user_profiles and answered 500 every Monday (2026-09-21, 09-28, 10-05); no
 * digest was ever sent and nobody saw it, because a cron has no user to
 * complain. The same sweep found RentalsService.create reading a member
 * borrower's name the same way: the read always failed and the rental kept
 * whatever name the client sent. Unit-test stubs answered both selects
 * happily, so nothing caught them.
 *
 * HOW THIS GUARD WORKS
 *   - scripts/postgrest-embeds/relationships.snapshot.json holds every public
 *     foreign key, the junctions PostgREST sees and the ambiguous pairs
 *     (relationships.mjs has the rules, checked against PostgREST 14).
 *     supabase/tests/postgrest_embed_relationships.test.sql fails when the
 *     database stops matching it, so a migration that adds a foreign key
 *     cannot leave this guard on old relationships.
 *   - scripts/postgrest-embeds/scan.mjs reads web (apps/web/src), phone
 *     (apps/mobile/app, apps/mobile/src) and core (packages/core/src), tests
 *     left out, finds every `.from(table)...select(columns)` and resolves
 *     `columns` through literals, templates, constants (imported ones too),
 *     joins and the call sites of helpers that take the table or the columns
 *     as parameters. Each embed is resolved from its parent table the way
 *     PostgREST resolves it.
 *   - A string literal that looks like a select with an embed but that no
 *     `.select()` with a known table reaches is reported as unattributed, so
 *     a select that travels a way the scan cannot follow is never skipped.
 *
 * IF THIS FAILS
 *   - "unnamed embed between an ambiguous pair": name the relationship the
 *     code means. Read the column it filters on or the row it describes, then
 *     add the foreign key as a hint, `user_profiles!returns_approved_by_fkey(...)`,
 *     or embed through the column, `approver:approved_by(...)`. A hint does
 *     not rename the embed: filters such as `.eq('user_profiles.x', ...)` keep
 *     working.
 *   - "names no relationship": the hint, column or constraint does not join
 *     these two tables (PostgREST answers PGRST200). A table embedding itself
 *     can be named only by its column (`locations!parent_id`).
 *   - "unattributed": tie the select to its table (pass it straight to
 *     `.from('t').select(...)`), or put `// postgrest-from: <table>` on the
 *     literal or its declaration.
 *   - "snapshot" or "pgTAP block": regenerate (below); never edit by hand.
 *
 * REGENERATE THE SNAPSHOT after a migration adds, drops or renames a foreign
 * key (pgTAP postgrest_embed_relationships fails until you do):
 *   pnpm exec supabase db reset                       local stack only
 *   node scripts/gen-postgrest-embed-snapshot.mjs      snapshot + pgTAP block
 * For a database you may only read: run scripts/postgrest-embeds/census.sql
 * there read-only, save the JSON and pass it with --census <file>.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/app', 'apps/mobile/src', 'packages/core/src'];
const TIMEOUT = 60_000;

/**
 * Embeds from or into a view: PostgREST infers a view's relationships from
 * its definition, which the snapshot does not model, so each one is checked
 * by hand against the local stack and listed here (`file:line parent > path`)
 * with why it is safe. Empty: no select embeds a view today.
 */
const REVIEWED_VIEW_EMBEDS: Record<string, string> = {};

interface Finding {
  file: string;
  line: number;
  via: string[];
  table: string;
  select: string;
  path?: string;
  parent?: string | null;
  target?: string;
  status?: string;
  reason?: string;
  candidates?: string[];
  message?: string;
  text?: string;
}
interface ScanResult {
  sites: Array<{
    file: string;
    line: number;
    table: string;
    select: string;
    embeds: Array<Record<string, unknown>>;
  }>;
  ambiguous: Finding[];
  noRelationship: Finding[];
  unchecked: Finding[];
  viewEmbeds: Finding[];
  parseErrors: Finding[];
  unattributed: Finding[];
  annotated: Array<{ file: string; line: number; tables: string[] }>;
  stats: { files: number; selectCalls: number; sitesWithEmbeds: number; embeds: number };
}
interface Snapshot {
  foreignKeys: Array<[string, string, string, string[], string[]]>;
  primaryKeys: Record<string, string[]>;
  views: string[];
  junctions: unknown[];
  ambiguousPairs: Array<{ a: string; b: string; relationships: string[] }>;
}
interface Libs {
  buildRelationshipModel: (census: {
    fks: Snapshot['foreignKeys'];
    pks: Snapshot['primaryKeys'];
    views: string[];
  }) => unknown;
  scanRepo: (opts: {
    repoRoot: string;
    roots?: string[];
    files?: string[];
    model: unknown;
  }) => ScanResult;
  checkCommitted: () => string[];
  snapshot: Snapshot;
}

async function loadLibs(): Promise<Libs> {
  const lib = (p: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, p)).href);
  const [rel, scan, gen] = await Promise.all([
    lib('scripts/postgrest-embeds/relationships.mjs'),
    lib('scripts/postgrest-embeds/scan.mjs'),
    lib('scripts/gen-postgrest-embed-snapshot.mjs'),
  ]);
  const snapshot = JSON.parse(
    readFileSync(path.join(ROOT, 'scripts/postgrest-embeds/relationships.snapshot.json'), 'utf8'),
  ) as Snapshot;
  return {
    buildRelationshipModel: rel.buildRelationshipModel,
    scanRepo: scan.scanRepo,
    checkCommitted: gen.checkCommitted,
    snapshot,
  };
}

const where = (f: Finding) =>
  `${f.file}:${f.line}${f.via.length > 0 ? ` (via ${f.via.join(' <- ')})` : ''}`;

let libs: Libs;
let model: unknown;
let scan: ScanResult;

beforeAll(async () => {
  libs = await loadLibs();
  const s = libs.snapshot;
  model = libs.buildRelationshipModel({ fks: s.foreignKeys, pks: s.primaryKeys, views: s.views });
  scan = libs.scanRepo({ repoRoot: ROOT, roots: ROOTS, model });
}, TIMEOUT);

describe('the relationship snapshot', () => {
  it('follows from its own foreign keys, and the pgTAP block that holds the database to it is current', () => {
    expect(libs.checkCommitted()).toEqual([]);
  });

  it('knows the pair that broke the weekly digest', () => {
    const pair = libs.snapshot.ambiguousPairs.find(
      (p) => p.a === 'organization_members' && p.b === 'user_profiles',
    );
    expect(pair?.relationships).toEqual([
      'organization_members_invited_by_fkey',
      'organization_members_user_id_fkey',
    ]);
  });
});

describe('PostgREST embeds in web, phone and core', () => {
  it('scans what it must scan (vacuity control)', () => {
    // Floors, far under today's numbers (190 select sites with embeds over
    // ~1,900 files): a scan that silently stops resolving selects fails here
    // instead of passing everything.
    expect(scan.stats.files).toBeGreaterThan(1000);
    expect(scan.stats.sitesWithEmbeds).toBeGreaterThan(120);
    const digest = scan.sites.find(
      (s) =>
        s.file === 'apps/web/src/app/api/cron/weekly-digest/route.ts' &&
        s.table === 'user_profiles' &&
        s.embeds.length > 0,
    );
    expect(digest?.embeds.map((e) => [e.path, e.status, e.table])).toEqual([
      ['organization_members', 'ok', 'organization_members'],
      ['organization_members > organizations:organization_id', 'ok', 'organizations'],
    ]);
    // The phone's Items tab reaches its select through two helper layers
    // (listRead -> scoped -> .from('inventory_items').select(columns)).
    const phoneItems = scan.sites.filter(
      (s) =>
        s.file === 'apps/mobile/app/(drawer)/(tabs)/inventory.tsx' && s.table === 'inventory_items',
    );
    expect(phoneItems.some((s) => s.embeds.some((e) => e.path === 'item_stock_levels'))).toBe(true);
  });

  it('every embed between two tables joined by more than one relationship names the one it means', () => {
    const problems = scan.ambiguous.map(
      (f) =>
        `${where(f)}: unnamed embed between an ambiguous pair, ${f.parent} -> ${f.path}; ` +
        `name one of: ${(f.candidates ?? []).join(', ')}`,
    );
    expect(problems).toEqual([]);
  });

  it('every hint, foreign key column and constraint target names a relationship that exists (no PGRST200)', () => {
    const problems = scan.noRelationship.map(
      (f) => `${where(f)}: ${f.parent} -> ${f.path} names no relationship between these tables`,
    );
    expect(problems).toEqual([]);
  });

  it('every select the scan reads parses, and no embed target or hint is built at run time', () => {
    const problems = [
      ...scan.parseErrors.map((f) => `${where(f)}: ${f.message}`),
      ...scan.unchecked.map(
        (f) => `${where(f)}: ${f.parent} -> ${f.path} is not static (${f.reason})`,
      ),
    ];
    expect(problems).toEqual([]);
  });

  it('every select fragment with an embed is tied to the table it is read from', () => {
    const problems = scan.unattributed.map(
      (f) =>
        `${where(f)}: unattributed select fragment ${f.text}; add // postgrest-from: <table> or pass it to .from(<table>).select()`,
    );
    expect(problems).toEqual([]);
  });

  it('every embed from or into a view has been checked by hand', () => {
    const found = scan.viewEmbeds.map((f) => `${f.file}:${f.line} ${f.parent} > ${f.path}`).sort();
    expect(found).toEqual(Object.keys(REVIEWED_VIEW_EMBEDS).sort());
  });
});

describe('the scan itself (planted selects)', () => {
  // Each case is a small source tree written to a temp folder and scanned with
  // the real snapshot. Unnamed embeds between an ambiguous pair must be
  // reported however the select is assembled; named ones never are.
  let dir: string;
  const run = (files: Record<string, string>): ScanResult => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'postgrest-embeds-'));
    const paths = Object.entries(files).map(([name, text]) => {
      const p = path.join(dir, name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    });
    try {
      return libs.scanRepo({ repoRoot: dir, files: paths, model });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const flagged = (r: ScanResult) =>
    r.ambiguous.map((f) => `${f.file}:${f.line} ${f.parent} -> ${f.path}`);

  it('reports the weekly digest select as it shipped', () => {
    const r = run({
      'route.ts': `
        export async function pull(admin: any) {
          return admin
            .from('user_profiles')
            .select(\`
              id, email,
              organization_members!inner (
                organization_id,
                organizations:organization_id (id, name)
              )\`)
            .not('organization_members.accepted_at', 'is', null);
        }`,
    });
    expect(flagged(r)).toEqual(['route.ts:5 user_profiles -> organization_members']);
  });

  it('accepts a constraint hint, a column hint, a column embed and a junction hint', () => {
    const r = run({
      'ok.ts': `
        export const a = (sb: any) => sb.from('user_profiles').select('id, organization_members!organization_members_user_id_fkey!inner(id)');
        export const b = (sb: any) => sb.from('organization_members').select('id, user:user_profiles!user_id(full_name)');
        export const c = (sb: any) => sb.from('returns').select('id, approver:approved_by(full_name), ...user_profiles!returns_requested_by_fkey(email)');
        export const d = (sb: any) => sb.from('organizations').select('id, user_profiles!order_submissions(id)');
        export const e = (sb: any) => sb.from('locations').select('id, parent:parent_id(id), locations!parent_id(id), locations(id)');`,
    });
    expect(flagged(r)).toEqual([]);
    expect(r.noRelationship).toEqual([]);
  });

  it('follows constants across files, templates, joins, spreads and helper parameters', () => {
    const r = run({
      'cols.ts': `
        export const MEMBER = 'user:user_profiles(full_name)';
        export const PARTS = ['id', 'status', 'picker:user_profiles(full_name)'];`,
      'service.ts': `
        import { MEMBER, PARTS } from './cols';
        const WITH_RETURNS = \`id, \${'returns'}(id, ...user_profiles(email))\`;
        function read(sb: any, table: string, columns: string) {
          return sb.from(table).select(columns);
        }
        export const one = (sb: any) => sb.from('organization_members').select(MEMBER);
        export const two = (sb: any) => read(sb, 'order_requests', PARTS.join(', '));
        export const three = (sb: any) => sb.from('order_requests').select(WITH_RETURNS);`,
    });
    expect(flagged(r).sort()).toEqual(
      [
        'service.ts:5 order_requests -> picker:user_profiles',
        'service.ts:7 organization_members -> user:user_profiles',
        'service.ts:9 returns -> returns > user_profiles',
      ].sort(),
    );
  });

  it('reports a hint that names no relationship, and a self embed named by its constraint', () => {
    const r = run({
      'bad.ts': `
        export const a = (sb: any) => sb.from('organizations').select('id, user_profiles!organization_members_user_id_fkey(id)');
        export const b = (sb: any) => sb.from('locations').select('id, locations!locations_parent_id_fkey(id)');`,
    });
    expect(r.noRelationship.map((f) => `${f.file}:${f.line} ${f.parent} -> ${f.path}`)).toEqual([
      'bad.ts:2 organizations -> user_profiles',
      'bad.ts:3 locations -> locations',
    ]);
  });

  it('reports a select fragment it cannot tie to a table, and checks it once annotated', () => {
    const unattributed = run({
      'frag.ts': `
        export const FRAGMENT = 'id, requester:user_profiles(full_name)';
        export function use(q: { select(s: string): unknown }) { return q.select(FRAGMENT); }`,
    });
    expect(unattributed.unattributed.map((f) => `${f.file}:${f.line}`)).toEqual(['frag.ts:2']);

    const annotated = run({
      'frag.ts': `
        // postgrest-from: order_requests
        export const FRAGMENT = 'id, requester:user_profiles(full_name)';
        export function use(q: { select(s: string): unknown }) { return q.select(FRAGMENT); }`,
    });
    expect(annotated.unattributed).toEqual([]);
    expect(flagged(annotated)).toEqual(['frag.ts:3 order_requests -> requester:user_profiles']);
  });
});
