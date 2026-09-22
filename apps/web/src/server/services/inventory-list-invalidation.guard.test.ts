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

function analyze(node: ts.Node, key: string, sf: ts.SourceFile): MemberFacts {
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
          else if (name in STOCK_RPCS) facts.writes.push(`rpc:${name}`);
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

/** Scan one file's source. Exported shape is exercised by the self-tests. */
function scanSource(fileName: string, source: string): FileFacts {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
        members.push(analyze(m, `${fileName}#${cls}.${memberName(m.name, sf)}`, sf));
      }
    } else if (ts.isFunctionDeclaration(st)) {
      members.push(analyze(st, `${fileName}#${st.name?.text ?? '<default>'}`, sf));
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const base = `${fileName}#${d.name.getText(sf)}`;
        const init = d.initializer ? unwrap(d.initializer) : undefined;
        if (init && ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties)
            members.push(analyze(p, `${base}.${memberName(p.name, sf)}`, sf));
        } else {
          members.push(analyze(d, base, sf));
        }
      }
    } else {
      members.push(analyze(st, `${fileName}#<top-level>`, sf));
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
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') }));
    const writesStock = classifyFunctions(migrations);

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
