/**
 * RECURRENCE GUARD — every holdings reader is classified, so a new one cannot
 * silently present a partial view as complete (0371).
 *
 * Since migration 0371 a member below manager (staff and viewers) reads
 * `item_stock_levels` only in their assigned warehouses, plus locations with no
 * warehouse. `quantity_on_hand` is still the org-wide total. So any code that
 * reads holdings through the caller's client and then either
 *   • ADDS THEM UP next to that total ("placed + awaiting = on hand"), or
 *   • DECIDES from them ("this item holds no stock, archive it"; "this book is
 *     in one crate, rewrite its summary"; "this location is empty"),
 * is wrong for a staff member unless it folds in what they cannot see:
 * `InventoryService.hiddenHoldingsFor` (item_holdings_elsewhere) or, for a
 * location, `location_stock_census`.
 *
 * This file lists every reader under apps/web/src/server and apps/web/src/app
 * (a `.from('item_stock_levels')` call, or a select string that embeds the
 * table), attributed to the class member or function that contains it, with
 * the reason it is safe:
 *   • 'folds-hidden'      — the same member (or the member it feeds, named in
 *                           `foldedBy`) folds in the hidden totals; checked
 *                           below by source.
 *   • 'complete-by-scope' — the reader is ABOUT what the caller can act on
 *                           (a source they can move from, a location they can
 *                           write), so the caller's own scope IS the answer.
 *   • 'label-only'        — a display label that never drives a write, left
 *                           partial by owner decision (design "NO CHANGE").
 *   • 'service-client'    — reads through the service role or system context,
 *                           where row level security does not apply.
 *
 * IF THIS FAILS: a reader was added, moved or removed. Decide which of the four
 * it is. If it adds holdings up or decides from them, fold in
 * hiddenHoldingsFor (in parallel with the read, never after it) and list it as
 * 'folds-hidden'. Never classify a reader 'complete-by-scope' because "staff
 * rarely reach it".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '../..');
const SCAN_ROOTS = [path.join(WEB_SRC, 'server'), path.join(WEB_SRC, 'app')];

type Classification = 'folds-hidden' | 'complete-by-scope' | 'label-only' | 'service-client';

interface Entry {
  classification: Classification;
  /** How many readers the member holds. */
  count: number;
  why: string;
  /**
   * 'folds-hidden' only: the members (same file) that fold the hidden totals
   * into what this reader returns. Each must call the fold token.
   */
  foldedBy?: string[];
}

/** Keyed `<path relative to apps/web/src>::<member>`. */
const READERS: Record<string, Entry> = {
  // ── InventoryService ───────────────────────────────────────────────────
  'server/services/inventory.ts::get': {
    classification: 'folds-hidden',
    count: 1,
    why: 'Staging/Unplaced sums for derivePlacement; withElsewhere folds the hidden buckets in before it.',
    foldedBy: ['get'],
  },
  'server/services/inventory.ts::placements': {
    classification: 'complete-by-scope',
    count: 1,
    why: 'Transfer SOURCES: only holdings the caller can move from. The item page passes the hidden totals separately (get withElsewhere) for the empty state.',
  },
  'server/services/inventory.ts::holdingsForGuard': {
    classification: 'folds-hidden',
    count: 1,
    why: 'Single-item archive guard; its caller adds the hidden units and fails closed without them.',
    foldedBy: ['assertArchivableOrThrow'],
  },
  'server/services/inventory.ts::holdingsForItemIds': {
    classification: 'folds-hidden',
    count: 1,
    why: 'The shared batched reader. Every caller that adds up or decides folds the hidden totals: list, the bulk archive guard, the crate rule input and bulk Set rack. placementBreakdown lines are completed by list()\'s elsewhere_quantity on the Items page.',
    foldedBy: [
      'list',
      'assertBulkArchivableOrThrow',
      'readPlacedHoldingsForCrateRule',
      'placeItemsOntoRackByName',
    ],
  },
  'server/services/inventory.ts::resolveAdjustLocation': {
    classification: 'complete-by-scope',
    count: 1,
    why: 'Picks the location an adjust lands in; it must be one the caller can write, which is what they can see (0371 design: now falls back to their own Unplaced instead of a 403).',
  },
  'server/services/inventory.ts::removeStockFromLocation': {
    classification: 'complete-by-scope',
    count: 1,
    why: 'Reads the one holding the caller is writing off; a location they cannot see is one they cannot write.',
  },
  'server/services/inventory.ts::stagedWorklist': {
    classification: 'complete-by-scope',
    count: 1,
    why: 'Put-away worklist: rows the caller can place (0371 design class a).',
  },
  // ── LocationsService ───────────────────────────────────────────────────
  'server/services/locations.ts::assertEmptyOrThrow': {
    classification: 'folds-hidden',
    count: 1,
    why: 'Only NAMES the items the caller can read; the decision is location_stock_census, org-wide.',
    foldedBy: ['assertEmptyOrThrow'],
  },
  // ── Others ─────────────────────────────────────────────────────────────
  'server/services/rack-holdings.ts::fetchRackHoldingsByItem': {
    classification: 'label-only',
    count: 1,
    why: 'Pick slip / packing slip / scanner lookup rack labels; never drives a write (design NO CHANGE, optional follow-up).',
  },
  'server/services/exceptions.ts::placementRules': {
    classification: 'service-client',
    count: 1,
    why: 'Exceptions sync (SystemServiceContext, admin client) reads every holding of the org.',
  },
  'server/services/opening-stock-compensation.ts::compensateOpeningStockOrThrow': {
    classification: 'complete-by-scope',
    count: 1,
    why: 'Verifies the just-created items\' opening holdings, which tg_seed_initial_level puts in the creator\'s own warehouse (or a location with no warehouse).',
  },
  'server/loaders/inventory-list.ts::loadInventoryRowsUncached': {
    classification: 'service-client',
    count: 1,
    why: 'Cached manager-only default-view loader (createAdminClient); staff and viewers never read it.',
  },
  'server/loaders/inventory-list.ts::loadInventoryDatasetUncached': {
    classification: 'service-client',
    count: 1,
    why: 'Cached manager-only instant dataset (createAdminClient); staff and viewers never read it.',
  },
  'app/api/v1/items/[id]/remove-stock/route.ts::POST': {
    classification: 'complete-by-scope',
    count: 1,
    why: 'Default quantity of the one holding the caller is writing off.',
  },
};

/** What folding looks like, per file. */
const FOLD_TOKENS: Record<string, RegExp> = {
  'server/services/inventory.ts': /\bthis\.hiddenHoldingsFor\(/,
  'server/services/locations.ts': /\.rpc\(\s*'location_stock_census'/,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** The class member, function, or top-level const that contains `node`. */
function ownerName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  let fallback: string | null = null;
  while (cur) {
    if (
      (ts.isMethodDeclaration(cur) || ts.isPropertyDeclaration(cur) || ts.isGetAccessor(cur)) &&
      cur.name &&
      ts.isClassLike(cur.parent)
    ) {
      return cur.name.getText();
    }
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.getText();
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && ts.isSourceFile(cur.parent.parent.parent)) {
      fallback = cur.name.getText();
    }
    cur = cur.parent;
  }
  return fallback ?? '<module>';
}

interface Found {
  key: string;
  file: string;
  member: string;
}

function findReaders(): Found[] {
  const found: Found[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('item_stock_levels')) continue;
      const rel = path.relative(WEB_SRC, file).split(path.sep).join('/');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        // `.from('item_stock_levels')`
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.getText() === 'from' &&
          node.arguments.length > 0 &&
          ts.isStringLiteralLike(node.arguments[0]!) &&
          (node.arguments[0] as ts.StringLiteralLike).text === 'item_stock_levels'
        ) {
          const member = ownerName(node);
          found.push({ key: `${rel}::${member}`, file: rel, member });
        }
        // An embed of the table inside another table's select string:
        // `item_stock_levels!inner(...)` or `item_stock_levels(...)`.
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.getText() === 'select' &&
          node.arguments.length > 0 &&
          ts.isStringLiteralLike(node.arguments[0]!) &&
          /item_stock_levels\s*(!\w+)?\s*\(/.test((node.arguments[0] as ts.StringLiteralLike).text)
        ) {
          const member = ownerName(node);
          found.push({ key: `${rel}::${member}`, file: rel, member });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return found;
}

/** The source text of each named member of a file (class members and functions). */
function memberSources(rel: string): Map<string, string> {
  const file = path.join(WEB_SRC, rel);
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      node.body
    ) {
      out.set(node.name.getText(), node.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('holdings readers are classified (0371)', () => {
  const found = findReaders();
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);

  it('finds the readers at all (the scan itself works)', () => {
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it('every reader is listed, with its exact count', () => {
    const unlisted = [...counts.keys()].filter((k) => !READERS[k]);
    expect(unlisted, `unclassified holdings readers: ${unlisted.join(', ')}`).toEqual([]);
    for (const [key, entry] of Object.entries(READERS)) {
      expect(counts.get(key) ?? 0, `${key}: reader count changed`).toBe(entry.count);
    }
  });

  it("every 'folds-hidden' reader is folded, by source", () => {
    for (const [key, entry] of Object.entries(READERS)) {
      if (entry.classification !== 'folds-hidden') continue;
      const [rel] = key.split('::') as [string, string];
      const token = FOLD_TOKENS[rel];
      expect(token, `${rel}: no fold token declared`).toBeDefined();
      const members = memberSources(rel);
      expect(entry.foldedBy?.length ?? 0, `${key}: name the member that folds`).toBeGreaterThan(0);
      for (const folder of entry.foldedBy ?? []) {
        const src = members.get(folder);
        expect(src, `${rel}::${folder} not found`).toBeDefined();
        expect(token!.test(src!), `${rel}::${folder} does not fold the hidden totals`).toBe(true);
      }
    }
  });

  it('the hidden-totals RPC is called in exactly one place, as a POST with its ids in the body', () => {
    const inventory = readFileSync(path.join(WEB_SRC, 'server/services/inventory.ts'), 'utf8');
    const calls = inventory.match(/\.rpc\(\s*'item_holdings_elsewhere'/g) ?? [];
    expect(calls).toHaveLength(1);
    const helper = memberSources('server/services/inventory.ts').get('hiddenHoldingsFor')!;
    expect(helper).toMatch(/\.rpc\(\s*'item_holdings_elsewhere',\s*\{\s*p_item_ids: batch,?\s*\}\s*\)/);
    // `{ get: true }` would put the ids in the URL (pattern #29).
    expect(helper).not.toMatch(/get:\s*true/);
    // And nothing else in the app calls it behind the helper's back.
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        if (file.endsWith(path.join('server', 'services', 'inventory.ts'))) continue;
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.rpc\(\s*'item_holdings_elsewhere'/);
      }
    }
  });
});

/**
 * InventoryService.list folds the hidden stock in only when asked
 * (`withElsewhere`, a review finding: every other caller threw it away and
 * still paid for the request). So every page that hands list() rows to the
 * item tables, whose placement columns add holdings up next to on hand, must
 * ask. A page that renders a table from list() without it shows a staff
 * member their own warehouses' figures as the whole.
 */
describe('pages that render the item tables from list() ask for the hidden stock', () => {
  const APP = path.join(WEB_SRC, 'app');
  const TABLE = /<(InventoryTable|BooksInventoryTable)\b/;
  const pages = walk(APP)
    .filter((f) => f.endsWith('.tsx') && !/\.test\.tsx$/.test(f))
    .map((f) => ({ rel: path.relative(WEB_SRC, f).split(path.sep).join('/'), src: readFileSync(f, 'utf8') }))
    .filter(({ src }) => TABLE.test(src));

  it('finds the Items, Books and Rentals item pages (the scan works)', () => {
    expect(pages.map((p) => p.rel).sort()).toEqual([
      'app/(dashboard)/dashboard/books/page.tsx',
      'app/(dashboard)/dashboard/inventory/page.tsx',
      'app/(dashboard)/dashboard/rentals/items/page.tsx',
    ]);
  });

  it.each(['books', 'inventory', 'rentals/items'])(
    'dashboard/%s: every inventory list() call passes withElsewhere: true, and a failed read is said',
    (page) => {
      const found = pages.find((p) => p.rel === `app/(dashboard)/dashboard/${page}/page.tsx`)!;
      const src = found.src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const calls = [...src.matchAll(/inventorySvc\.list\(\{/g)];
      expect(calls.length, 'the page reads through inventorySvc.list').toBeGreaterThan(0);
      for (const call of calls) {
        const body = src.slice(call.index!, src.indexOf('})', call.index!));
        expect(body).toContain('withElsewhere: true');
      }
      // The note is driven by list()'s own flag, not a constant.
      expect(src).toMatch(/<ElsewhereUnavailableNotice unavailable=\{[\w.]+\.elsewhereUnavailable\}>/);
    },
  );
});
