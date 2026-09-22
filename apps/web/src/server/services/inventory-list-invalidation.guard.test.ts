/**
 * RECURRENCE GUARD — a service method that moves stock invalidates the cached
 * Items/Books views itself.
 *
 * The Items and Books pages are served from unstable_cache entries tagged
 * inventory-list-<org> (loaders/inventory-list.ts, 60s TTL, shared by every
 * manager of the org). The 2026-09-22 census found five write paths that moved
 * stock and left those entries alone, because the invalidation lived in the
 * CALLERS and each of these callers forgot it:
 *   • POST /api/v1/cycle-counts/[id]/post — the iPhone app's only way to post
 *     a count (the web action invalidated, the route did not);
 *   • the web "Reopen picking" action (reopen_picking gives stock back);
 *   • a schedule event completing into distribute_bundle;
 *   • the AI tools cancelOrder (restocks) and applyReorderPoint (badge);
 *   • PO-import approve/cancel (re-charter / archive import-created items).
 *
 * The invalidation now lives in the service write methods, and this file
 * fails when a method in apps/web/src/server/services
 *   (a) calls a stock-moving RPC (STOCK_RPCS), or
 *   (b) inserts/updates/upserts/deletes inventory_items, item_stock_levels or
 *       stock_movements,
 * without calling invalidateInventoryListAfterWrite (imported from
 * ./lib/inventory-list-cache) somewhere in the same method.
 *
 * WHY EVERY inventory_items WRITE COUNTS, not only quantity/status: the
 * trigger tg_inventory_items_set_updated_at bumps updated_at on any UPDATE
 * except an embedding/search_vector-only one (migration 0242), and updated_at
 * is both a rendered column and the default view's sort key. A write to a
 * column no list reads still reorders the cached page.
 *
 * FOUR WAYS A WRITE COULD HIDE FROM A SCAN, each closed below:
 *   1. an RPC that moves stock but is missing from STOCK_RPCS — the list is
 *      cross-checked against the migrations: every RPC a service calls whose
 *      LATEST definition writes a stock table (directly or through another
 *      function it calls) must be listed;
 *   2. a query builder that escapes into a variable (`const q =
 *      sb.from('inventory_items'); q.update(…)`) — every `.from('<stock
 *      table>')` must be followed directly by its verb;
 *   3. a table or RPC name that is not a literal — a non-literal RPC, or a
 *      non-literal table that is written (a `.select` read cannot move
 *      stock), is refused unless DYNAMIC_WRITE_ALLOWLIST says whether it can
 *      reach a stock table; one that can is held to the same rule as (b);
 *   4. a look-alike helper — the call only counts when the file imports the
 *      real one from lib/inventory-list-cache.
 *
 * The unit of attribution is a class member, a top-level function or const,
 * or a method of a top-level object literal. A write inside a nested closure
 * belongs to the member that contains it.
 *
 * IF THIS FAILS: add the invalidation to the method, right after its first
 * stock write commits (the helper's doc explains why one call covers the rest
 * of the request). Put a method in ALLOWLIST only when invalidating would be
 * WRONG, and say why; a method that merely "is always called by something
 * that already invalidates" does not qualify — that is exactly how the five
 * gaps above were left behind.
 *
 * A call being PRESENT is not enough: the second half of this file covers
 * stock written outside services (web and phone) and the call shapes Next
 * records but never acts on (streamed bodies, dropped promises, after(),
 * render). The AI chat route's write tools were such a case.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVICES_DIR = __dirname;
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../supabase/migrations');

const HELPER = 'invalidateInventoryListAfterWrite';
const HELPER_MODULE = /(^|\/)lib\/inventory-list-cache$/;

const STOCK_TABLES = new Set(['inventory_items', 'item_stock_levels', 'stock_movements']);
const WRITE_VERBS = new Set(['insert', 'update', 'upsert', 'delete']);
const BUILDER_VERBS = new Set(['select', ...WRITE_VERBS]);

/**
 * Every RPC a service calls that changes what the cached views render, with
 * what it writes. The migration cross-check below proves this list complete
 * for the RPCs services call today; it only has to be edited when a service
 * starts calling a new one.
 */
const STOCK_RPCS: Record<string, string> = {
  adjust_stock: 'inventory_items.quantity_on_hand, item_stock_levels, stock_movements',
  transfer_stock: 'item_stock_levels (the holdings behind Staged/Unplaced/Placed), stock_movements',
  post_receipt_v2: 'adjust_stock per accepted line',
  reverse_receipt: 'adjust_stock per reversed line',
  post_cycle_count: 'inventory_items, stock_movements, item_stock_levels via apply_level_delta',
  distribute_bundle: 'inventory_items, stock_movements, item_stock_levels via apply_level_delta',
  assemble_bundle: 'inventory_items (components + phantom kit item), stock_movements',
  process_return_disposition: 'inventory_items, stock_movements (restock or scrap)',
  cancel_order_request: 'adjust_stock (restocks a drawn batch)',
  complete_picking: 'adjust_stock (draws the picked batch)',
  reopen_picking: 'adjust_stock (gives the draw back)',
  duplicate_inventory_item: 'inventory_items insert + opening stock_movements',
  inventory_set_rack: 'inventory_items.bin_location + rack custom_fields',
  inventory_set_bin_location: 'inventory_items.bin_location',
  inventory_set_book_placement: 'inventory_items book_crate_* / rack custom_fields',
};

/**
 * Members allowed to write stock WITHOUT invalidating: `file#Member` → why
 * invalidating would be wrong. Empty on purpose — as of 2026-09-22 every
 * writer invalidates. A stale entry (member gone, no longer writes, or now
 * invalidates) fails the suite so the list cannot rot.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * Members that WRITE through a non-literal table name (or call a non-literal
 * RPC): `file#Member` → whether the name can reach a stock table, and why.
 * `stock: true` members must invalidate exactly like a literal stock write.
 * Found by this guard on its first run: RecoveryService.restore un-deletes
 * inventory_items through ENTITY_TABLE[entity] and was invisible to a
 * literal-only scan.
 */
const DYNAMIC_WRITE_ALLOWLIST: Record<string, { stock: boolean; reason: string }> = {
  'restore-points.ts#ensureRefMap': {
    stock: false,
    reason: "`table` is typed 'categories' | 'suppliers'; inserts missing lookup rows",
  },
  'recovery.ts#RecoveryService.restore': {
    stock: true,
    reason: "ENTITY_TABLE[entity] includes 'inventory_items' (un-delete)",
  },
};

/* ───────────────────────────── source scan ───────────────────────────── */

interface MemberFacts {
  key: string;
  /** e.g. "rpc:adjust_stock" or "update:inventory_items" */
  writes: string[];
  invalidates: boolean;
  /** `.from('<stock table>')` NOT followed directly by a builder verb. */
  escapedBuilders: string[];
  /** A `.rpc(x)`, or a `.from(x)` not followed by `.select`, whose x is not
   *  a string literal. */
  dynamicWrites: string[];
}

interface FileFacts {
  members: MemberFacts[];
  /** The file imports the real helper from lib/inventory-list-cache. */
  importsHelper: boolean;
}

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function literalArg(call: ts.CallExpression): string | null {
  const first = call.arguments[0];
  if (!first) return null;
  const u = unwrap(first);
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : null;
}

/** `Array.from(…)`, `Buffer.from(…)`, `x.storage.from(BUCKET)` are not tables. */
function isNonTableFrom(receiver: ts.Node): boolean {
  const r = unwrap(receiver);
  if (ts.isIdentifier(r))
    return r.text === 'Array' || r.text === 'Buffer' || r.text === 'Uint8Array';
  return ts.isPropertyAccessExpression(r) && r.name.text === 'storage';
}

/** The method called directly on a `.from(…)` result, or null when the
 *  builder is stored, passed or returned instead. */
function builderVerb(fromCall: ts.CallExpression): string | null {
  let parent: ts.Node = fromCall.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    parent = parent.parent;
  }
  return ts.isPropertyAccessExpression(parent) ? parent.name.text : null;
}

type StockRpcTest = (rpcName: string) => boolean;
const isListedStockRpc: StockRpcTest = (n) => n in STOCK_RPCS;

function analyze(
  node: ts.Node,
  key: string,
  sf: ts.SourceFile,
  isStockRpc: StockRpcTest = isListedStockRpc,
): MemberFacts {
  const facts: MemberFacts = {
    key,
    writes: [],
    invalidates: false,
    escapedBuilders: [],
    dynamicWrites: [],
  };
  const where = (n: ts.Node) =>
    `${key}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee) && callee.text === HELPER) facts.invalidates = true;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === 'rpc') {
          const name = literalArg(n);
          if (name === null) facts.dynamicWrites.push(`rpc@${where(n)}`);
          else if (isStockRpc(name)) facts.writes.push(`rpc:${name}`);
        }
        if (method === 'from' && !isNonTableFrom(callee.expression)) {
          const table = literalArg(n);
          const verb = builderVerb(n);
          if (table === null) {
            if (verb !== 'select') facts.dynamicWrites.push(`from@${where(n)}`);
          } else if (STOCK_TABLES.has(table)) {
            if (verb === null || !BUILDER_VERBS.has(verb)) {
              facts.escapedBuilders.push(`${table}@${where(n)}`);
            } else if (WRITE_VERBS.has(verb)) {
              facts.writes.push(`${verb}:${table}`);
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  facts.writes = [...new Set(facts.writes)];
  return facts;
}

function memberName(name: ts.PropertyName | undefined, sf: ts.SourceFile): string {
  return name ? name.getText(sf) : 'constructor';
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Scan one file's source. Exported shape is exercised by the self-tests. */
function scanSource(
  fileName: string,
  source: string,
  isStockRpc: StockRpcTest = isListedStockRpc,
): FileFacts {
  const sf = parse(fileName, source);
  const members: MemberFacts[] = [];
  let importsHelper = false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const named = st.importClause?.namedBindings;
      if (
        HELPER_MODULE.test(spec) &&
        named &&
        ts.isNamedImports(named) &&
        named.elements.some((e) => e.name.text === HELPER && !e.propertyName)
      ) {
        importsHelper = true;
      }
    } else if (ts.isClassDeclaration(st)) {
      const cls = st.name?.text ?? '<anonymous class>';
      for (const m of st.members) {
        members.push(analyze(m, `${fileName}#${cls}.${memberName(m.name, sf)}`, sf, isStockRpc));
      }
    } else if (ts.isFunctionDeclaration(st)) {
      members.push(analyze(st, `${fileName}#${st.name?.text ?? '<default>'}`, sf, isStockRpc));
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const base = `${fileName}#${d.name.getText(sf)}`;
        const init = d.initializer ? unwrap(d.initializer) : undefined;
        if (init && ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties)
            members.push(analyze(p, `${base}.${memberName(p.name, sf)}`, sf, isStockRpc));
        } else {
          members.push(analyze(d, base, sf, isStockRpc));
        }
      }
    } else {
      members.push(analyze(st, `${fileName}#<top-level>`, sf, isStockRpc));
    }
  }
  return { members, importsHelper };
}

function serviceFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...serviceFiles(path.join(dir, e.name), relPath));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(relPath);
  }
  return out.sort();
}

/* ─────────────────────── migration classification ─────────────────────── */

const STOCK_TABLE_WRITE =
  /\b(?:update\s+(?:only\s+)?(?:public\.)?(?:inventory_items|item_stock_levels|stock_movements)\b|insert\s+into\s+(?:public\.)?(?:inventory_items|item_stock_levels|stock_movements)\b|delete\s+from\s+(?:only\s+)?(?:public\.)?(?:inventory_items|item_stock_levels|stock_movements)\b)/i;

/**
 * name → true when the LATEST definition of public.<name> across the ordered
 * migrations writes a stock table, directly or through any function it calls
 * (fixpoint over the call graph). Bodies are the dollar-quoted text; `--`
 * comments are stripped so prose naming a table does not count.
 */
function classifyFunctions(migrations: Array<{ file: string; sql: string }>): Map<string, boolean> {
  const bodies = new Map<string, string>();
  const header =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const { sql } of migrations) {
    header.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = header.exec(sql))) {
      const tagRe = /\$([a-z_]*)\$/gi;
      tagRe.lastIndex = m.index;
      const open = tagRe.exec(sql);
      if (!open) continue;
      const start = open.index + open[0].length;
      const end = sql.indexOf(open[0], start);
      if (end < 0) continue;
      bodies.set(m[1]!.toLowerCase(), sql.slice(start, end).replace(/--[^\n]*/g, ''));
    }
  }
  const writes = new Map<string, boolean>();
  const calls = new Map<string, Set<string>>();
  for (const [name, body] of bodies) {
    writes.set(name, STOCK_TABLE_WRITE.test(body));
    const called = new Set<string>();
    const callRe = /\b([a-z_][a-z0-9_]*)\s*\(/gi;
    let c: RegExpExecArray | null;
    while ((c = callRe.exec(body))) {
      const callee = c[1]!.toLowerCase();
      if (callee !== name && bodies.has(callee)) called.add(callee);
    }
    calls.set(name, called);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, called] of calls) {
      if (writes.get(name)) continue;
      if ([...called].some((c) => writes.get(c))) {
        writes.set(name, true);
        changed = true;
      }
    }
  }
  return writes;
}

let stockWritersMemo: Map<string, boolean> | null = null;
/** classifyFunctions over the real migrations, read once per file run. */
function migrationStockWriters(): Map<string, boolean> {
  stockWritersMemo ??= classifyFunctions(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') })),
  );
  return stockWritersMemo;
}

/* ─────────────────────────── the machinery ─────────────────────────── */

describe('the scan machinery itself', () => {
  const facts = (src: string) => {
    const f = scanSource('x.ts', src);
    return Object.fromEntries(f.members.map((m) => [m.key, m]));
  };

  it('flags a stock RPC and a stock-table write, and sees the invalidation', () => {
    const m = facts(`
      class S {
        async a() { await this.ctx.supabase.rpc('adjust_stock', {}); }
        async b() {
          await this.ctx.supabase.rpc('reopen_picking', {});
          invalidateInventoryListAfterWrite(this.ctx.organizationId, 'x');
        }
        async c() { await this.ctx.supabase.from('inventory_items').update({ a: 1 }).eq('id', 1); }
        async d() { await this.ctx.supabase.from('inventory_items').select('id'); }
        async e() { await this.ctx.supabase.rpc('approve_order_request', {}); }
      }
    `);
    expect(m['x.ts#S.a']).toMatchObject({ writes: ['rpc:adjust_stock'], invalidates: false });
    expect(m['x.ts#S.b']).toMatchObject({ writes: ['rpc:reopen_picking'], invalidates: true });
    expect(m['x.ts#S.c']).toMatchObject({ writes: ['update:inventory_items'], invalidates: false });
    expect(m['x.ts#S.d']?.writes).toEqual([]);
    // Reservations only: not a stock RPC for the cached views.
    expect(m['x.ts#S.e']?.writes).toEqual([]);
  });

  it('unwraps casts and parentheses, and attributes nested closures to their member', () => {
    const m = facts(`
      export async function top(ctx) {
        const run = async () => {
          await (ctx.supabase.from('stock_movements') as any).insert([]);
        };
        await run();
      }
      export const helper = async (sb) => { await sb.from('item_stock_levels')!.delete().eq('a', 1); };
      export const api = {
        async one(sb) { await sb.from('inventory_items').upsert({}); },
        async two(sb) { await sb.from('orders').update({}); },
      };
    `);
    expect(m['x.ts#top']?.writes).toEqual(['insert:stock_movements']);
    expect(m['x.ts#helper']?.writes).toEqual(['delete:item_stock_levels']);
    expect(m['x.ts#api.one']?.writes).toEqual(['upsert:inventory_items']);
    expect(m['x.ts#api.two']?.writes).toEqual([]);
  });

  it('reports a builder that escapes into a variable, and non-literal names', () => {
    const m = facts(`
      class S {
        async a() { const q = this.ctx.supabase.from('inventory_items'); await q.update({}); }
        async b(t) { await this.ctx.supabase.from(t).update({ deleted_at: null }); }
        async b2(t) { await this.ctx.supabase.from(t).select('id'); }
        async c(n) { await this.ctx.supabase.rpc(n, {}); }
        async d() {
          const ids = Array.from(new Set([1]));
          await this.ctx.supabase.storage.from(BUCKET).remove(['p']);
        }
      }
    `);
    expect(m['x.ts#S.a']?.escapedBuilders).toHaveLength(1);
    expect(m['x.ts#S.b']?.dynamicWrites).toHaveLength(1);
    // A read through a non-literal table cannot move stock.
    expect(m['x.ts#S.b2']?.dynamicWrites).toEqual([]);
    expect(m['x.ts#S.c']?.dynamicWrites).toHaveLength(1);
    expect(m['x.ts#S.d']).toMatchObject({ dynamicWrites: [], escapedBuilders: [] });
  });

  it('counts the helper only when it is imported from lib/inventory-list-cache', () => {
    expect(
      scanSource(
        'x.ts',
        "import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';",
      ).importsHelper,
    ).toBe(true);
    expect(
      scanSource('x.ts', "import { invalidateInventoryListAfterWrite } from './somewhere-else';")
        .importsHelper,
    ).toBe(false);
    // An aliased import of something else under the helper's name does not count.
    expect(
      scanSource(
        'x.ts',
        "import { other as invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';",
      ).importsHelper,
    ).toBe(false);
  });

  it('classifies migration functions transitively and ignores comments', () => {
    const w = classifyFunctions([
      {
        file: '0001.sql',
        sql: `
          create or replace function public.writer() returns void language plpgsql as $$
          begin update public.inventory_items set quantity_on_hand = 0; end; $$;
          create function public.caller() returns void language plpgsql as $function$
          begin perform public.writer(); end; $function$;
          create or replace function public.reader() returns int language sql as $$
            -- update public.inventory_items is only named in this comment
            select count(*) from public.inventory_items; $$;
        `,
      },
      {
        file: '0002.sql',
        // A later definition wins: writer no longer writes, so caller no longer does.
        sql: `create or replace function public.writer() returns void language sql as $$ select 1; $$;`,
      },
    ]);
    expect(w.get('writer')).toBe(false);
    expect(w.get('caller')).toBe(false);
    expect(w.get('reader')).toBe(false);

    const w2 = classifyFunctions([
      {
        file: '0001.sql',
        sql: `
          create function public.lvl() returns void language plpgsql as $$
          begin insert into public.item_stock_levels values (1); end; $$;
          create function public.outer_fn() returns void language plpgsql as $$
          begin perform lvl(); end; $$;
        `,
      },
    ]);
    expect(w2.get('lvl')).toBe(true);
    expect(w2.get('outer_fn')).toBe(true);
  });
});

/* ───────────────────────────── the guard ───────────────────────────── */

describe('every service stock write invalidates the Items/Books list cache', () => {
  const files = serviceFiles(SERVICES_DIR);
  const scanned = files.map((file) => ({
    file,
    ...scanSource(file, readFileSync(path.join(SERVICES_DIR, file), 'utf8')),
  }));
  const members = scanned.flatMap((f) => f.members);

  it('scans the real service tree (sanity: the known writers are found)', () => {
    const keys = new Set(members.filter((m) => m.writes.length > 0).map((m) => m.key));
    for (const k of [
      'cycle-counts.ts#CycleCountsService.post',
      'order-requests.ts#OrderRequestsService.reopenPicking',
      'order-requests.ts#OrderRequestsService.cancel',
      'schedule.ts#ScheduleService.update',
      'po-imports.ts#PoImportsService.approve',
      'inventory.ts#InventoryService.adjustStock',
      'inventory.ts#InventoryService.update',
    ]) {
      expect(keys, k).toContain(k);
    }
  });

  it('no stock-writing member is missing the invalidation', () => {
    const missing = members
      .filter((m) => m.writes.length > 0 && !m.invalidates && !(m.key in ALLOWLIST))
      .map((m) => `${m.key}  [${m.writes.join(', ')}]`);
    expect(missing, 'add invalidateInventoryListAfterWrite after the write commits').toEqual([]);
  });

  it('a member writing through a non-literal name that can reach stock invalidates too', () => {
    const missing = members
      .filter((m) => DYNAMIC_WRITE_ALLOWLIST[m.key]?.stock === true && !m.invalidates)
      .map((m) => m.key);
    expect(missing).toEqual([]);
  });

  it('every file that calls the helper imports the real one', () => {
    const bad = scanned
      .filter((f) => f.members.some((m) => m.invalidates) && !f.importsHelper)
      .map((f) => f.file);
    expect(bad).toEqual([]);
  });

  it('no stock-table query builder escapes into a variable', () => {
    expect(members.flatMap((m) => m.escapedBuilders)).toEqual([]);
  });

  it('no write through a non-literal table or RPC name outside the reasoned allowlist', () => {
    const offenders = members
      .filter((m) => m.dynamicWrites.length > 0 && !(m.key in DYNAMIC_WRITE_ALLOWLIST))
      .map((m) => m.dynamicWrites.join(', '));
    expect(offenders, 'classify these in DYNAMIC_WRITE_ALLOWLIST').toEqual([]);
    const stale = Object.keys(DYNAMIC_WRITE_ALLOWLIST).filter(
      (k) => !members.some((m) => m.key === k && m.dynamicWrites.length > 0),
    );
    expect(stale, 'DYNAMIC_WRITE_ALLOWLIST entry no longer needed').toEqual([]);
  });

  it('ALLOWLIST entries are live: each still writes and still does not invalidate', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (k) => !members.some((m) => m.key === k && m.writes.length > 0 && !m.invalidates),
    );
    expect(stale).toEqual([]);
  });

  describe('STOCK_RPCS agrees with the migrations', () => {
    const writesStock = migrationStockWriters();

    const calledRpcs = new Set<string>();
    for (const file of files) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(path.join(SERVICES_DIR, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'rpc') {
            const name = literalArg(n);
            if (name) calledRpcs.add(name);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }

    it('every RPC a service calls that writes a stock table is in STOCK_RPCS', () => {
      const unlisted = [...calledRpcs]
        .filter((n) => writesStock.get(n) && !(n in STOCK_RPCS))
        .sort();
      expect(unlisted, 'add these to STOCK_RPCS (and invalidate where they are called)').toEqual(
        [],
      );
    });

    it('every STOCK_RPCS entry is still defined and still writes stock', () => {
      const stale = Object.keys(STOCK_RPCS)
        .filter((n) => writesStock.get(n) !== true)
        .sort();
      expect(stale).toEqual([]);
    });
  });
});

/* ═══════════════════ outside the services tree, and context ═══════════════════
 *
 * The guard above proves every SERVICE write CALLS the invalidation. Two holes
 * remained, and the AI chat route fell into the second:
 *
 *  A. Stock written OUTSIDE services: server actions, route handlers, lib/
 *     helpers, and the phone (apps/mobile talks to Postgres directly for some
 *     screens). Scanned below with the same AST rules, against every RPC whose
 *     latest migration writes stock (not just STOCK_RPCS). Each writer
 *     invalidates, or is listed with the reason it cannot change what the
 *     Items/Books lists render, or is a KNOWN GAP with its remediation.
 *
 *  B. A call that is PRESENT but that Next never acts on. revalidateTag only
 *     records a tag on the request's work store; Next sends it to the cache at
 *     fixed points (the Server Action's end, a Route Handler's return, the
 *     after() flush) and never afterwards. Proven in
 *     lib/inventory-list-cache.test.ts through Next's real App Route module.
 *     Statically detectable shapes, each checked below:
 *       - code inside a streamed body (new ReadableStream / TransformStream)
 *         that reaches the helper without runStreamedStockWrites around it,
 *         or that records a tag directly (revalidateTag / revalidatePath /
 *         updateTag) where no such scope exists;
 *       - a stock-writing service call that is not awaited (`void svc.x()`,
 *         a bare statement): it can finish after the request did;
 *       - a stock-writing service call inside after() or defer(): Next's
 *         after() flush drops a tag the request already recorded (same tag and
 *         profile), which a request that wrote stock before has;
 *       - a stock-writing service call during render (app pages/layouts,
 *         server/loaders, components) or inside unstable_cache: revalidateTag
 *         throws there (revalidate.js: "during render", E7 / E306) and the
 *         never-throwing wrapper can only log it.
 *     Route handlers, crons and server actions that AWAIT the write before
 *     returning are the effective shape and need nothing more.
 *
 * NOT SCANNED, deliberately: apps/web/scripts (seed / perf-lab operator
 * scripts). They run outside any request, against seed and perf orgs, so
 * there is no Next cache to reach; a list they touch expires on its own
 * within LIST_TTL_SEC (60 s, loaders/inventory-list.ts).
 */

const APPS_DIR = path.resolve(__dirname, '../../../..');
const WEB_SRC = path.join(APPS_DIR, 'web/src');
const OUTSIDE_ROOTS = ['web/src', 'mobile/app', 'mobile/src'];
const HELPER_FILE = path.join(WEB_SRC, 'server/services/lib/inventory-list-cache.ts');
const STREAM_SCOPE = 'runStreamedStockWrites';

/**
 * Writers outside services that do NOT invalidate because the write cannot
 * change anything the cached Items/Books views render. Keys are relative to
 * apps/. Self-checking: an entry that stops writing, or starts invalidating,
 * fails.
 */
const OUTSIDE_ALLOWLIST: Record<string, string> = {
  'web/src/app/api/v1/movements/[id]/note/route.ts#PATCH':
    'edit_movement_note writes stock_movements.notes only (0307); the lists read movements only as quantity_change + created_at for the 14-day trend (services/lib/item-trends.ts)',
  'web/src/server/actions/movements.ts#editMovementNoteAction':
    'edit_movement_note writes stock_movements.notes only (0307); the lists never read movement notes',
  'web/src/lib/ai/embeddings.ts#embedInventoryItem':
    'writes inventory_items.embedding only; tg_inventory_items_set_updated_at (0242, restated 0303) keeps updated_at for an embedding-only change and no list column reads embedding',
  'web/src/lib/ai/embeddings.ts#embedItemsBatch':
    'writes inventory_items.embedding only; same trigger exemption as embedInventoryItem',
};

/**
 * Writers outside services that DO leave the cached views stale and are not
 * fixed yet. Listed so the gap is visible and a new one cannot join it
 * silently. Self-checking like the allowlist.
 */
const OUTSIDE_KNOWN_GAPS: Record<string, string> = {
  'mobile/app/item/[id].tsx#ItemDetail':
    'the phone item screen (quick +/-1/5 buttons and the Adjust sheet) calls the raw adjust_stock RPC straight to Postgres: no Next request exists to expire the web cache, so web lists show the pre-adjust quantity for up to LIST_TTL_SEC (60 s). Remediation: route it through POST /api/v1/items/[id]/adjust (InventoryService.adjustStock), which invalidates and also enforces stock:adjust server-side (the RPC checks only the staff role)',
};

/** Outside members that store a stock-table builder in a variable but only
 *  ever read through it. */
const OUTSIDE_ESCAPED_READS: Record<string, string> = {
  'mobile/src/lib/category-counts.ts#countItemsByCategory':
    "`client.from('inventory_items') as CategoryCountsTable` is only .select()ed (category tallies)",
};

/**
 * Files that build a streamed body and reach the helper module, yet need no
 * runStreamedStockWrites, with why. Empty: the only streamed body today is
 * /api/ai/chat, and it uses the scope.
 */
const STREAM_ALLOWLIST: Record<string, string> = {};

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts'))
      out.push(abs);
  }
  return out;
}

/** Every non-test TS file under the outside roots, relative to apps/. */
function outsideFiles(): string[] {
  return OUTSIDE_ROOTS.flatMap((r) => walkFiles(path.join(APPS_DIR, r)))
    .map((abs) => path.relative(APPS_DIR, abs).split(path.sep).join('/'))
    .filter(
      (rel) => !rel.startsWith('web/src/server/services/') && !rel.startsWith('web/src/test/'),
    )
    .sort();
}

/** Resolve an app import (`@/x` or relative) to an absolute .ts/.tsx path. */
function resolveImport(fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else return null;
  for (const c of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

interface ImportFacts {
  spec: string;
  resolved: string | null;
  /** local name → imported name */
  names: Map<string, string>;
  typeOnly: boolean;
}

function importsOf(fromAbs: string, sf: ts.SourceFile): ImportFacts[] {
  const out: ImportFacts[] = [];
  const visit = (n: ts.Node): void => {
    let spec: string | null = null;
    let typeOnly = false;
    const names = new Map<string, string>();
    if (ts.isImportDeclaration(n)) {
      spec = (n.moduleSpecifier as ts.StringLiteral).text;
      typeOnly = !!n.importClause?.isTypeOnly;
      const nb = n.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb))
        for (const e of nb.elements)
          if (!e.isTypeOnly) names.set(e.name.text, (e.propertyName ?? e.name).text);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      spec = (n.moduleSpecifier as ts.StringLiteral).text;
      typeOnly = n.isTypeOnly;
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      spec = n.arguments[0].text;
    }
    if (spec !== null) out.push({ spec, resolved: resolveImport(fromAbs, spec), names, typeOnly });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const TAG_RECORDERS = new Set(['revalidateTag', 'revalidatePath', 'updateTag', 'refresh']);

/** Every module the file can load at runtime (static + dynamic imports). */
function reachableFrom(startAbs: string): Set<string> {
  const seen = new Set<string>();
  const queue = [startAbs];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const i of importsOf(f, parse(f, readFileSync(f, 'utf8'))))
      if (i.resolved && !i.typeOnly) queue.push(i.resolved);
  }
  return seen;
}

/** Service callables that write stock and invalidate, from the scan above. */
function invalidatingCallables(members: MemberFacts[]) {
  const byClass = new Map<string, Set<string>>();
  const fns = new Set<string>();
  for (const m of members) {
    if (!m.invalidates) continue;
    const local = m.key.slice(m.key.indexOf('#') + 1);
    if (local.startsWith('<')) continue;
    const dot = local.indexOf('.');
    if (dot < 0) fns.add(local);
    else {
      const cls = local.slice(0, dot);
      if (!byClass.has(cls)) byClass.set(cls, new Set());
      byClass.get(cls)!.add(local.slice(dot + 1));
    }
  }
  return { byClass, fns };
}

/** `new C(…)`, `C.forCurrentUser(…)`, optionally awaited / parenthesised. */
function constructedClass(expr: ts.Node | undefined): string | null {
  if (!expr) return null;
  let e = unwrap(expr);
  while (ts.isAwaitExpression(e)) e = unwrap(e.expression);
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    /^for[A-Z]/.test(e.expression.name.text)
  )
    return e.expression.expression.text;
  return null;
}

interface StockCall {
  where: string;
  call: ts.CallExpression;
  label: string;
}

/**
 * Calls in `sf` to an invalidating service callable. The receiver of a
 * method call is traced through `new C()`, `C.forCurrentUser()`, a variable
 * initialised from either, or `this` inside class C. Name-based within the
 * file, which over-reports rather than under-reports.
 */
function stockCalls(
  rel: string,
  sf: ts.SourceFile,
  callables: ReturnType<typeof invalidatingCallables>,
  importedFns: Set<string>,
): StockCall[] {
  const varClass = new Map<string, string>();
  const collectVars = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const c = constructedClass(n.initializer);
      if (c) varClass.set(n.name.text, c);
    }
    ts.forEachChild(n, collectVars);
  };
  collectVars(sf);
  const out: StockCall[] = [];
  const visit = (n: ts.Node, cls: string | null): void => {
    const nextCls = ts.isClassDeclaration(n) && n.name ? n.name.text : cls;
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      let label: string | null = null;
      if (ts.isIdentifier(callee) && importedFns.has(callee.text)) label = callee.text;
      if (ts.isPropertyAccessExpression(callee)) {
        const recv = unwrap(callee.expression);
        const c =
          recv.kind === ts.SyntaxKind.ThisKeyword
            ? cls
            : ts.isIdentifier(recv)
              ? (varClass.get(recv.text) ?? null)
              : constructedClass(recv);
        if (c && callables.byClass.get(c)?.has(callee.name.text))
          label = `${c}.${callee.name.text}`;
      }
      if (label) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        out.push({ where: `${rel}:${line}`, call: n, label });
      }
    }
    ts.forEachChild(n, (c) => visit(c, nextCls));
  };
  visit(sf, null);
  return out;
}

/** The call's promise is dropped: `void x()` or `x();` as a statement, also
 *  through .then/.catch/.finally chains. */
function isFloating(call: ts.CallExpression): boolean {
  let n: ts.Node = call;
  for (;;) {
    const p = n.parent;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) {
      n = p;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(p) &&
      ['then', 'catch', 'finally'].includes(p.name.text) &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      n = p.parent;
      continue;
    }
    return ts.isVoidExpression(p) || ts.isExpressionStatement(p);
  }
}

/** Name of the nearest enclosing call whose callback argument holds `node`,
 *  when that call is one of `names`. */
function insideCallbackOf(node: ts.Node, names: Set<string>): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (
        name &&
        names.has(name) &&
        n.arguments.some((a) => node.pos >= a.pos && node.end <= a.end)
      )
        return name;
    }
  }
  return null;
}

/** Files that run during a render: Next page files, loaders, components. */
const RENDER_FILE =
  /^web\/src\/(app\/.*\/(page|layout|template|default|not-found|error|loading)\.tsx?|server\/loaders\/.*|components\/.*)$/;

describe('the outside-services scan machinery', () => {
  const callables = {
    byClass: new Map([['InventoryService', new Set(['adjustStock'])]]),
    fns: new Set(['linkFamily']),
  };
  const calls = (src: string) => {
    const sf = parse('x.ts', src);
    return stockCalls('x.ts', sf, callables, new Set(['linkFamily']));
  };

  it('traces receivers through new, forCurrentUser, variables and this', () => {
    const found = calls(`
      async function a(ctx) { await new InventoryService(ctx).adjustStock({}); }
      async function b() { const svc = await InventoryService.forCurrentUser(); await svc.adjustStock({}); }
      async function c(ctx) { await linkFamily({}, {}); }
      async function d(ctx) { const other = new OtherService(ctx); await other.adjustStock({}); }
      class InventoryService { async x() { await this.adjustStock({}); } }
    `);
    expect(found.map((f) => f.label)).toEqual([
      'InventoryService.adjustStock',
      'InventoryService.adjustStock',
      'linkFamily',
      'InventoryService.adjustStock',
    ]);
  });

  it('tells awaited calls from dropped ones', () => {
    const found = calls(`
      async function a(ctx) {
        const svc = new InventoryService(ctx);
        await svc.adjustStock({});
        void svc.adjustStock({});
        svc.adjustStock({}).catch(() => {});
        return svc.adjustStock({});
      }
    `);
    expect(found.map((f) => isFloating(f.call))).toEqual([false, true, true, false]);
  });

  it('finds calls inside after()/defer() and unstable_cache callbacks', () => {
    const found = calls(`
      async function a(ctx) {
        const svc = new InventoryService(ctx);
        after(() => svc.adjustStock({}));
        defer(async () => { await svc.adjustStock({}); });
        const load = unstable_cache(async () => svc.adjustStock({}), ['k']);
        await svc.adjustStock({});
      }
    `);
    const names = new Set(['after', 'defer', 'unstable_cache']);
    expect(found.map((f) => insideCallbackOf(f.call, names))).toEqual([
      'after',
      'defer',
      'unstable_cache',
      null,
    ]);
  });

  it('classifies render files', () => {
    expect(RENDER_FILE.test('web/src/app/(dashboard)/dashboard/inventory/page.tsx')).toBe(true);
    expect(RENDER_FILE.test('web/src/server/loaders/inventory-list.ts')).toBe(true);
    expect(RENDER_FILE.test('web/src/components/inventory/item-detail.tsx')).toBe(true);
    expect(RENDER_FILE.test('web/src/app/api/v1/items/route.ts')).toBe(false);
    expect(RENDER_FILE.test('web/src/server/actions/inventory.ts')).toBe(false);
  });
});

describe('stock writes outside services, and invalidations Next would drop', () => {
  const writers = migrationStockWriters();
  const isStockRpc: StockRpcTest = (n) => writers.get(n) === true;
  const files = outsideFiles();
  const scanned = files.map((rel) => ({
    rel,
    ...scanSource(rel, readFileSync(path.join(APPS_DIR, rel), 'utf8'), isStockRpc),
  }));
  const members = scanned.flatMap((f) => f.members);

  const serviceMembers = serviceFiles(SERVICES_DIR).flatMap(
    (file) => scanSource(file, readFileSync(path.join(SERVICES_DIR, file), 'utf8')).members,
  );
  const callables = invalidatingCallables(serviceMembers);

  /** Per web file: its source, and the invalidating callables it imports. */
  const webSources = [
    ...files.filter((r) => r.startsWith('web/')),
    ...serviceFiles(SERVICES_DIR).map((f) => `web/src/server/services/${f}`),
  ].map((rel) => {
    const abs = path.join(APPS_DIR, rel);
    const sf = parse(rel, readFileSync(abs, 'utf8'));
    const importedFns = new Set<string>();
    for (const i of importsOf(abs, sf)) {
      if (!i.resolved?.startsWith(SERVICES_DIR)) continue;
      for (const [local, imported] of i.names)
        if (callables.fns.has(imported)) importedFns.add(local);
    }
    return { rel, abs, sf, calls: stockCalls(rel, sf, callables, importedFns) };
  });

  it('scans the phone and the web outside services (sanity: known writers are found)', () => {
    const keys = new Set(members.filter((m) => m.writes.length > 0).map((m) => m.key));
    for (const k of [
      'web/src/server/actions/item-visibility.ts#setItemPublicVisibilityAction',
      'web/src/lib/ai/embeddings.ts#embedItemsBatch',
      'mobile/app/item/[id].tsx#ItemDetail',
    ]) {
      expect(keys, k).toContain(k);
    }
    expect(callables.byClass.get('OrderRequestsService')).toContain('cancel');
    expect(callables.byClass.get('InventoryService')).toContain('update');
  });

  it('every stock write outside services invalidates, or is listed with why it may not', () => {
    const missing = members
      .filter(
        (m) =>
          m.writes.length > 0 &&
          !m.invalidates &&
          !(m.key in OUTSIDE_ALLOWLIST) &&
          !(m.key in OUTSIDE_KNOWN_GAPS),
      )
      .map((m) => `${m.key}  [${m.writes.join(', ')}]`);
    expect(missing, 'call invalidateInventoryListAfterWrite after the write commits').toEqual([]);
  });

  it('allowlist and known-gap entries are live: each still writes and still does not invalidate', () => {
    const stale = [...Object.keys(OUTSIDE_ALLOWLIST), ...Object.keys(OUTSIDE_KNOWN_GAPS)].filter(
      (k) => !members.some((m) => m.key === k && m.writes.length > 0 && !m.invalidates),
    );
    expect(stale).toEqual([]);
  });

  it('no stock-table builder escapes outside services, and no unclassified dynamic write', () => {
    const escaped = members
      .filter((m) => m.escapedBuilders.length > 0 && !(m.key in OUTSIDE_ESCAPED_READS))
      .flatMap((m) => m.escapedBuilders);
    expect(escaped).toEqual([]);
    const staleReads = Object.keys(OUTSIDE_ESCAPED_READS).filter(
      (k) => !members.some((m) => m.key === k && m.escapedBuilders.length > 0),
    );
    expect(staleReads).toEqual([]);
    expect(members.flatMap((m) => m.dynamicWrites)).toEqual([]);
  });

  it('every outside file that calls the helper imports the real one', () => {
    const bad = scanned
      .filter((f) => f.members.some((m) => m.invalidates) && !f.importsHelper)
      .map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it('a streamed body that can reach a stock write runs it inside runStreamedStockWrites', () => {
    const offenders: string[] = [];
    for (const { rel, abs, sf } of webSources) {
      const streams: ts.NewExpression[] = [];
      const find = (n: ts.Node): void => {
        if (
          ts.isNewExpression(n) &&
          ts.isIdentifier(n.expression) &&
          (n.expression.text === 'ReadableStream' || n.expression.text === 'TransformStream')
        )
          streams.push(n);
        ts.forEachChild(n, find);
      };
      find(sf);
      if (streams.length === 0 || rel in STREAM_ALLOWLIST) continue;
      if (!reachableFrom(abs).has(HELPER_FILE)) continue;
      const scopeImported = importsOf(abs, sf).some(
        (i) => i.resolved === HELPER_FILE && i.names.get(STREAM_SCOPE) === STREAM_SCOPE,
      );
      for (const s of streams) {
        let wrapped = false;
        const look = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === STREAM_SCOPE
          )
            wrapped = true;
          ts.forEachChild(n, look);
        };
        for (const a of s.arguments ?? []) look(a);
        if (!wrapped || !scopeImported)
          offenders.push(`${rel}:${sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1}`);
      }
    }
    expect(offenders, 'wrap the stream body in runStreamedStockWrites').toEqual([]);
  });

  it('nothing a streamed body can reach records a cache tag outside the helper', () => {
    const offenders: string[] = [];
    for (const { rel, abs, sf } of webSources) {
      if (!/new (ReadableStream|TransformStream)\b/.test(sf.text) || rel in STREAM_ALLOWLIST)
        continue;
      for (const f of reachableFrom(abs)) {
        if (f === HELPER_FILE) continue;
        for (const i of importsOf(f, parse(f, readFileSync(f, 'utf8'))))
          if (i.spec === 'next/cache' && [...i.names.values()].some((n) => TAG_RECORDERS.has(n)))
            offenders.push(`${rel} -> ${path.relative(WEB_SRC, f)}`);
      }
    }
    // Such a tag is recorded after the handler returned and never sent.
    expect(offenders).toEqual([]);
  });

  it('no stock-writing service call is left un-awaited', () => {
    const floating = webSources.flatMap(({ calls }) =>
      calls.filter((c) => isFloating(c.call)).map((c) => `${c.where} ${c.label}`),
    );
    expect(floating, 'await it: a dropped promise can finish after the request').toEqual([]);
  });

  it('no stock-writing service call runs inside after() or defer()', () => {
    const tails = webSources.flatMap(({ calls }) =>
      calls
        .filter((c) => insideCallbackOf(c.call, new Set(['after', 'defer'])))
        .map((c) => `${c.where} ${c.label}`),
    );
    expect(tails, 'after() drops a tag the request already recorded').toEqual([]);
  });

  it('no stock-writing service call runs during a render or inside unstable_cache', () => {
    const bad = webSources.flatMap(({ rel, calls }) =>
      calls
        .filter(
          (c) => RENDER_FILE.test(rel) || insideCallbackOf(c.call, new Set(['unstable_cache'])),
        )
        .map((c) => `${c.where} ${c.label}`),
    );
    expect(bad, 'revalidateTag throws during render and in unstable_cache').toEqual([]);
  });
});
