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
 *   - A method is followed through `this.name(...)` in its class and every
 *     `.name(...)` call with a fitting number of arguments anywhere.
 *   - A call path whose builder, table or select the scan cannot resolve is
 *     reported as unchecked when an embed could travel it, and a select with
 *     more alternatives than the scan follows is reported as truncated.
 *   - A string literal that looks like a select with an embed (alone or with
 *     the literals it is concatenated with) but that no `.select()` with a
 *     known table reaches is reported as unattributed, so a select that
 *     travels a way the scan cannot follow is never skipped.
 *
 * IF THIS FAILS
 *   - "unnamed embed between an ambiguous pair": name the relationship the
 *     code means. Read the column it filters on or the row it describes, then
 *     add the foreign key as a hint, `user_profiles!returns_approved_by_fkey(...)`,
 *     or embed through the column, `approver:approved_by(...)`. A hint does
 *     not rename the embed: filters such as `.eq('user_profiles.x', ...)` keep
 *     working.
 *   - "names no relationship": the hint, column or constraint does not join
 *     these two tables (PostgREST answers PGRST200). For a table embedding
 *     itself, the constraint name answers PGRST200: embed through the column
 *     or hint the column (next point).
 *   - "a table embedded from itself": the two directions of a self foreign
 *     key read alike and return different rows (PostgREST 14, checked on the
 *     local stack 2026-10-05). `parent:parent_id(...)` returns the row this
 *     one points at (the parent; `x:disabled_by(...)` on user_profiles is
 *     the person who disabled this one), as an object. `locations(...)` and
 *     `locations!parent_id(...)` return the rows that point at this one (the
 *     children; `user_profiles!disabled_by(...)` is the people this one
 *     disabled), as an array. For the parent, embed through the column. For
 *     the children, list the select in REVIEWED_SELF_EMBEDS below.
 *   - "unattributed": tie the select to its table (pass it straight to
 *     `.from('t').select(...)`), or put `// postgrest-from: <table>` on the
 *     literal or its declaration.
 *   - "a call path the scan cannot resolve": pass the table and the select
 *     the scan can follow (a literal, a constant, a helper parameter), or
 *     put `// postgrest-from: <table>` on the `.select()` statement when the
 *     builder is one it cannot follow (an rpc, a builder returned by a call).
 *   - "truncated": the select has more alternatives than the scan follows;
 *     split it so each `.select()` has fewer.
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

/**
 * Embeds of a table from ITSELF by name (`locations(...)`,
 * `locations!parent_id(...)`): they return the rows that point at this one
 * (the children), which reads like "the parent" and is not. Each one is
 * checked by hand and listed here (`file:line parent > path`) with why the
 * children are what it means. Empty: no select embeds a table from itself
 * today.
 */
const REVIEWED_SELF_EMBEDS: Record<string, string> = {};

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
  scope?: string;
  hints?: string[];
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
  selfEmbeds: Finding[];
  parseErrors: Finding[];
  unattributed: Finding[];
  annotated: Array<{ file: string; line: number; tables: string[] }>;
  truncated: Array<{ file: string; line: number }>;
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
      ...scan.unchecked.map((f) =>
        f.scope === 'path'
          ? `${where(f)}: a call path the scan cannot resolve, while an embed could travel it: ${f.reason}; select ${f.select}`
          : `${where(f)}: ${f.parent} -> ${f.path} is not static (${f.reason})`,
      ),
      ...scan.truncated.map(
        (f) =>
          `${f.file}:${f.line}: more alternatives than the scan follows (truncated); split the select`,
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

  it('every embed of a table from itself by name has been checked by hand (it returns the children)', () => {
    const found = scan.selfEmbeds.map((f) => `${f.file}:${f.line} ${f.parent} > ${f.path}`).sort();
    expect(found).toEqual(Object.keys(REVIEWED_SELF_EMBEDS).sort());
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

  it('lists a table embedded from itself by name for a hand check, and not the parent embedded through its column', () => {
    // `locations!parent_id(...)` and `locations(...)` return the CHILDREN (an
    // array); `parent:parent_id(...)` returns the parent (an object).
    const r = run({
      'self.ts': `
        export const a = (sb: any) => sb.from('locations').select('id, parent:parent_id(id), locations!parent_id(id), locations(id)');
        export const b = (sb: any) => sb.from('user_profiles').select('id, disabler:disabled_by(id), user_profiles!disabled_by(id)');`,
    });
    expect(r.selfEmbeds.map((f) => `${f.file}:${f.line} ${f.parent} > ${f.path}`)).toEqual([
      'self.ts:2 locations > locations',
      'self.ts:2 locations > locations',
      'self.ts:3 user_profiles > user_profiles',
    ]);
    expect(r.selfEmbeds.map((f) => f.hints)).toEqual([['parent_id'], [], ['disabled_by']]);
    expect(flagged(r)).toEqual([]);
    expect(r.noRelationship).toEqual([]);
  });

  it('follows a method called from another module through an instance (by name)', () => {
    // The same constant also reaches a path the scan always followed
    // (this.list -> notifications, one relationship), so before methods were
    // followed by name this select was never checked against returns.
    const r = run({
      'svc.ts': `
        export const OK_COLS = 'id, x:user_profiles(full_name)';
        export class S {
          constructor(private ctx: any) {}
          okList() { return this.list(OK_COLS); }
          list(c: string) { return this.ctx.supabase.from('notifications').select(c); }
          listReturns(c: string) { return this.ctx.supabase.from('returns').select(c); }
        }`,
      'use.ts': `
        import { OK_COLS, S } from './svc';
        export const read = (ctx: any) => new S(ctx).listReturns(OK_COLS);`,
      'arrow.ts': `
        export class R {
          constructor(private sb: any) {}
          read = (cols: string) => this.sb.from('rentals').select(cols);
        }
        export const viaArrow = (sb: any) => new R(sb).read('id, borrower:user_profiles(full_name)');`,
    });
    expect(flagged(r).sort()).toEqual(
      [
        'arrow.ts:4 rentals -> borrower:user_profiles',
        'svc.ts:7 returns -> x:user_profiles',
      ].sort(),
    );
    expect(r.unattributed).toEqual([]);
  });

  it('reports a path whose table it cannot read when the select has an embed, even if another path checked it', () => {
    const r = run({
      'h.ts': `
        const COLS = 'id, x:user_profiles(full_name)';
        export function readUsers(sb: any, table: string) { return sb.from(table).select(COLS); }
        export const a = (sb: any) => readUsers(sb, 'notifications');
        export const b = (sb: any, t: string) => readUsers(sb, t);`,
    });
    expect(r.unchecked.map((f) => `${f.file}:${f.line} ${f.reason}`)).toEqual([
      'h.ts:3 its table is not static',
    ]);
    expect(flagged(r)).toEqual([]);
  });

  it('reports a path whose select it cannot read when another path of the same select carries an embed', () => {
    const r = run({
      'p.ts': `
        export function read(sb: any, cols: string) { return sb.from('returns').select(cols); }
        export const a = (sb: any) => read(sb, 'id, approved_by');
        export const b = (sb: any) => read(sb, 'id, approver:user_profiles!returns_approved_by_fkey(full_name)');
        export const c = (sb: any, cols: string) => read(sb, cols);`,
    });
    expect(r.unchecked.map((f) => `${f.file}:${f.line} ${f.reason}`)).toEqual([
      'p.ts:2 its select is not static, and another path of this .select() carries an embed',
    ]);
  });

  it('reports an rpc builder carrying an embed, and checks it once its table is named', () => {
    const bare = run({
      'rpc.ts': `
        export const a = (sb: any) => sb.rpc('list_returns').select('id, x:user_profiles(full_name)');`,
    });
    expect(bare.unchecked.map((f) => `${f.file}:${f.line} ${f.reason}`)).toEqual([
      'rpc.ts:2 the builder is an rpc()',
    ]);
    expect(bare.unattributed).toEqual([]);

    const named = run({
      'rpc.ts': `
        export const a = (sb: any) =>
          // postgrest-from: returns
          sb.rpc('list_returns').select('id, x:user_profiles(full_name)');`,
    });
    expect(named.unchecked).toEqual([]);
    expect(flagged(named)).toEqual(['rpc.ts:4 returns -> x:user_profiles']);
  });

  it('reports a fragment split over concatenated literals that no select reaches', () => {
    const r = run({
      'split.ts': `
        const COLS = 'full_name';
        export const SEL = 'id, x:user_profiles(' + COLS + ')';`,
    });
    expect(r.unattributed.map((f) => `${f.file}:${f.line}`)).toEqual(['split.ts:3']);
  });

  it('reports a select with more alternatives than it follows', () => {
    const r = run({
      'many.ts': `
        export const q = (sb: any, a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean, g: boolean) =>
          sb.from('notifications').select(
            (a ? 'id,' : 'uid,') + (b ? 'x,' : 'y,') + (c ? 'p,' : 'q,') + (d ? 'r,' : 's,') +
            (e ? 't,' : 'u,') + (f ? 'v,' : 'w,') + (g ? 'user:user_profiles(id)' : 'n'));`,
    });
    expect(r.truncated.map((f) => `${f.file}:${f.line}`)).toEqual(['many.ts:3']);
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
        export function use(q: { select(s: string): unknown }) { return q.select(FRAGMENT); }
        export function pass(fn: (s: string) => unknown) { return fn(FRAGMENT); }`,
    });
    // The .select() whose builder came in as a parameter carries the embed
    // on a path it cannot resolve.
    expect(unattributed.unchecked.map((f) => `${f.file}:${f.line} ${f.reason}`)).toEqual([
      'frag.ts:3 its builder is not followed (builder passed in as a parameter)',
    ]);
    // A fragment no .select() reads at all is unattributed.
    const loose = run({
      'loose.ts': `
        export const FRAGMENT = 'id, requester:user_profiles(full_name)';`,
    });
    expect(loose.unattributed.map((f) => `${f.file}:${f.line}`)).toEqual(['loose.ts:2']);

    const annotated = run({
      'frag.ts': `
        // postgrest-from: order_requests
        export const FRAGMENT = 'id, requester:user_profiles(full_name)';
        export function use(q: { select(s: string): unknown }) { return q.select(FRAGMENT); }`,
    });
    expect(annotated.unattributed).toEqual([]);
    expect(annotated.unchecked).toEqual([]);
    // Checked where it is read, with the table its literal names.
    expect(flagged(annotated)).toEqual(['frag.ts:4 order_requests -> requester:user_profiles']);
  });
});
