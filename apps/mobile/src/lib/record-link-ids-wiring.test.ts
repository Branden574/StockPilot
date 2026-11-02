import * as path from 'node:path';

import { verificationRefusalCopy } from '@stockpilot/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseTsx, readSource } from './__fixtures__/jsx-touch-audit';
import { rewriteWebPath } from './web-path-rewrite';

/**
 * A LINK TO A RECORD WITH A MISTYPED ID SAYS "NOT FOUND" (B65), READ AS SOURCE.
 *
 * The order, item, purchase order and PO import screens put the link's id
 * straight into a database read on a uuid column. Postgres refuses a value
 * that is not a uuid, so a mistyped or cut-off link showed the database's own
 * error text ("invalid input syntax for type uuid") with a Try again that
 * could never work; the item screen said "Check your connection and try
 * again." and, after a cold-start link, its OK left the person on a spinner.
 * The exception screen refused the id before asking, but said "The server
 * sent an unexpected answer." with a Try again. The Scan tab read the item by
 * id with any 36 hex digits or hyphens after an item-label path.
 *
 * Each screen now checks the id with core isUuid before any read, online or
 * offline, and a malformed id goes to that screen's own not-found state with
 * no request and no Try again. The mobile suite has no React Native renderer,
 * so the screens are read with the TypeScript parser, comments stripped (a
 * comment can never satisfy a pin).
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const ORDER = 'app/order/[id].tsx';
const ITEM = 'app/item/[id].tsx';
const PO = 'app/po/[id].tsx';
const PO_IMPORT = 'app/po-import/[id].tsx';
const EXCEPTION = 'app/exceptions/[id].tsx';
const SCAN_TAB = 'app/(drawer)/(tabs)/scan.tsx';

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The same, with every run of whitespace made one space. */
function flat(src: string): string {
  return codeOnly(src).replace(/\s+/g, ' ');
}

/** The names a file imports from '@stockpilot/core'. */
function coreImports(file: string): string[] {
  const sf = parseTsx(sourceOf(file), file);
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== '@stockpilot/core') {
      continue;
    }
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.push(el.name.text);
    }
  }
  return names;
}

/**
 * The body of `const <name> = React.useCallback(async (...) => { ... }, [...])`
 * inside the screen, flattened. Found by the parser, so a dependency list
 * that grows never moves the slice.
 */
function callbackBody(file: string, name: string): string {
  const sf = parseTsx(sourceOf(file), file);
  let body: string | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'React.useCallback'
    ) {
      const fn = n.initializer.arguments[0];
      if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) body = fn.body.getText(sf);
    }
    if (body === null) ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(body, `${name} in ${file}`).not.toBeNull();
  return flat(body!);
}

/** Where `needle` is in `hay`; fails the test when it is not there. */
function at(hay: string, needle: string): number {
  const i = hay.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
}

/** The text from `start` up to (not including) `end`. */
function between(hay: string, start: string, end: string): string {
  const from = at(hay, start);
  const to = hay.indexOf(end, from + start.length);
  expect(to, `${end} after ${start}`).toBeGreaterThan(from);
  return hay.slice(from, to);
}

// ── Order ────────────────────────────────────────────────────────────────

describe('order screen: a malformed link id is "Order not found."', () => {
  const load = callbackBody(ORDER, 'load');

  it('checks the id with core isUuid', () => {
    expect(coreImports(ORDER)).toContain('isUuid');
  });

  // Mutation caught: the check deleted, or moved below the offline return or
  // the header read (the raw "invalid input syntax" text with Try again).
  it('checks it before the offline return and before any read, and shows the not-found state', () => {
    const check = at(load, 'if (!isUuid(id)) {');
    expect(at(load, 'if (!orgId || !id) return;')).toBeLessThan(check);
    expect(check).toBeLessThan(at(load, 'if (offline) {'));
    expect(check).toBeLessThan(at(load, "from('order_requests')"));
    expect(check).toBeLessThan(at(load, "from('order_request_lines')"));
    expect(between(load, 'if (!isUuid(id)) {', 'if (offline) {')).toMatch(
      /^if \(!isUuid\(id\)\) \{ setOrder\(null\); setLoadError\(null\); setLoading\(false\); return; \} $/,
    );
  });

  // Mutation caught: offline, a malformed id said "needs a connection" when
  // no connection could ever open it.
  it('offline, a malformed id still says "Order not found.", never the offline sentence', () => {
    expect(flat(sourceOf(ORDER))).toContain(
      'const loadError = offline && order === null && isUuid(id) ? ORDER_OFFLINE_NOTHING_LOADED_COPY : loadErrorState;',
    );
  });
});

// ── Item ─────────────────────────────────────────────────────────────────

describe('item screen: a malformed link id is "Not found", and OK always leads somewhere', () => {
  const src = sourceOf(ITEM);
  const code = flat(src);
  const load = callbackBody(ITEM, 'load');

  it('checks the id with core isUuid', () => {
    expect(coreImports(ITEM)).toContain('isUuid');
  });

  // Mutation caught: the check deleted, or moved below any of the three reads
  // ("Check your connection and try again." for a link that could never load).
  it('checks it before the elsewhere read, the unconfirmed-stock mark and the item read', () => {
    const check = at(load, 'if (!isUuid(id)) {');
    expect(at(load, 'if (!id) return;')).toBeLessThan(check);
    expect(check).toBeLessThan(at(load, 'readItemElsewhere(supabase, id, role)'));
    expect(check).toBeLessThan(at(load, 'unconfirmedStock.beginRead(id)'));
    expect(check).toBeLessThan(at(load, ".from('inventory_items')"));
  });

  // Mutation caught: the ref guard deleted (load runs again whenever `role`
  // changes, and there is no await to stop a second alert on top of the first).
  it('raises the alert once per id, sets no state, and returns', () => {
    const branch = between(load, 'if (!isUuid(id)) {', 'const seq = ++loadSeq.current;');
    expect(branch).toMatch(
      /^if \(!isUuid\(id\)\) \{ if \(notFoundAlertedFor\.current === id\) return; notFoundAlertedFor\.current = id; Alert\.alert\('Not found', ITEM_NOT_FOUND_COPY, \[ \{ text: 'OK', onPress: \(\) => leaveItemScreen\(router\) \}, \]\); return; \} $/,
    );
    expect(branch).not.toMatch(/\bset[A-Z]\w*\(/);
    expect(code).toContain('const notFoundAlertedFor = React.useRef<string | null>(null);');
  });

  it("says core's not-found sentence, which is true for an item this member cannot see", () => {
    const literal = src.match(/^const ITEM_NOT_FOUND_COPY =\s*'([^']+)';$/m);
    expect(literal?.[1]).toBe(verificationRefusalCopy('not_found', 'item'));
    expect(load).toContain(
      "if (!data) { Alert.alert('Not found', ITEM_NOT_FOUND_COPY, [ { text: 'OK', onPress: () => leaveItemScreen(router) }, ]); return; }",
    );
    expect(code).not.toContain('This item no longer exists.');
  });

  // Mutation caught: a bare router.back() (after a cold-start link there is
  // nothing behind the screen, and OK or Back left the person on the spinner).
  it('every way out goes back when it can and Home when it cannot', () => {
    expect(code.match(/router\.back\(\)/g)).toHaveLength(1);
    expect(code).toMatch(
      /function leaveItemScreen\(router: \w+\): void \{ if \(router\.canGoBack\(\)\) router\.back\(\); else router\.replace\('\/'\); \}/,
    );
    // The malformed-id alert, both load alerts, and the header Back.
    expect(code.match(/leaveItemScreen\(router\)/g)).toHaveLength(4);
    expect(code).toContain(
      '<IconChip icon={ChevronLeft} onPress={() => leaveItemScreen(router)} accessibilityLabel="Back" minTap />',
    );
    expect(load).toContain(
      "Alert.alert('Could not load this item', 'Check your connection and try again.', [ { text: 'OK', onPress: () => leaveItemScreen(router) }, ]);",
    );
  });

  // Mutation caught: either guard deleted (a ?tab=movements or ?tab=activity
  // link read the ledger with the malformed id).
  it.each(['fetchMovementsPage', 'fetchAuditsPage'])(
    '%s returns before any read for a malformed id',
    (name) => {
      const body = callbackBody(ITEM, name);
      const guard = at(
        body,
        'if (!id || !orgId || !isUuid(id)) return { ok: true, rows: [], count: 0 };',
      );
      expect(guard).toBeLessThan(at(body, '.from('));
    },
  );

  it('the verification card is already guarded (it refuses a malformed id before asking)', () => {
    expect(code).toContain(
      'useItemVerification(id, item?.organization_id ?? orgId, verificationNonce)',
    );
    expect(flat(sourceOf('src/lib/verification-api.ts'))).toMatch(
      /if \(!UUID\.test\(itemId\)\) throw new VerificationResponseError\('invalid_id'\); const res = await api<unknown>\(`\/api\/v1\/items\/\$\{itemId\}\/verification`/,
    );
  });
});

// ── Purchase order ───────────────────────────────────────────────────────

describe('purchase order screen: a malformed link id is "This PO was not found"', () => {
  const load = callbackBody(PO, 'load');

  it('checks the id with core isUuid', () => {
    expect(coreImports(PO)).toContain('isUuid');
  });

  // Mutation caught: the check deleted or moved below the reads (the raw
  // text, "pull to retry" and a Try again that could never work).
  it('checks it before the reads, and clears to the not-found state with no error', () => {
    const check = at(load, 'if (!isUuid(id)) {');
    expect(at(load, 'if (!id || !orgId) return;')).toBeLessThan(check);
    expect(check).toBeLessThan(at(load, 'await Promise.all(['));
    if (load.includes('void loadChecks();')) {
      expect(check).toBeLessThan(load.indexOf('void loadChecks();'));
    }
    expect(load).toContain(
      'if (!isUuid(id)) { setHeader(null); setLines([]); setGroups({}); setReceipts([]); setLoadError(null); setLoading(false); return; }',
    );
  });

  // The not-uuid branch sets six pieces of state before any await, so a
  // note ending "everything else is post-await" with no word of it is false,
  // and a reader trusting it could move or drop the suppression.
  it("the effect's lint note names the not-uuid sets ahead of its post-await claim", () => {
    const note = between(
      sourceOf(PO),
      '// eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount',
      '\n',
    );
    const notUuid = at(
      note,
      'a link id that is not a uuid sets the not-found state at once (no read)',
    );
    expect(notUuid).toBeLessThan(at(note, 'everything else is post-await'));
  });
});

// ── PO import ────────────────────────────────────────────────────────────

describe('PO import screen: a malformed link id is "This import was not found"', () => {
  const load = callbackBody(PO_IMPORT, 'load');

  it('checks the id with core isUuid', () => {
    expect(coreImports(PO_IMPORT)).toContain('isUuid');
  });

  // Mutation caught: the check deleted or moved below the reads.
  it('checks it before the reads, and clears to the not-found state with no error (so no Try again)', () => {
    const check = at(load, 'if (!isUuid(id)) {');
    expect(at(load, 'if (!id || !orgId) return;')).toBeLessThan(check);
    expect(check).toBeLessThan(at(load, 'await Promise.all(['));
    expect(load).toContain(
      'if (!isUuid(id)) { setHeader(null); setLines([]); setPredecessor(null); setReplacement(null); setLoadError(null); setLoading(false); return; }',
    );
  });

  it("the effect's lint note no longer says every set is post-await", () => {
    const effect = between(
      sourceOf(PO_IMPORT),
      '// eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount',
      'void load();',
    );
    expect(effect).not.toContain('every set is post-await');
    expect(effect).toContain(
      'a link id that is not a uuid sets the not-found state at once (no read)',
    );
  });
});

// ── Exception ────────────────────────────────────────────────────────────

describe('exception screen: a malformed link id is "not available", with no Try again', () => {
  const code = flat(sourceOf(EXCEPTION));
  const load = callbackBody(EXCEPTION, 'load');

  it('checks the id with core isUuid', () => {
    expect(coreImports(EXCEPTION)).toContain('isUuid');
  });

  // Mutation caught: the guard deleted ("The server sent an unexpected
  // answer." from getException's own refusal).
  it('load returns before getException for a malformed id', () => {
    expect(load).toMatch(/^\{ if \(!id \|\| !isUuid\(id\) \|\| !orgId \|\| offline\) return;/);
    expect(at(load, '!isUuid(id)')).toBeLessThan(at(load, 'getException(id)'));
  });

  // Mutation caught: the derived state after the offline branch (offline, a
  // malformed id said "needs a connection").
  it('derives the not-available state ahead of the offline view, in the 404 sentence', () => {
    const malformed = at(
      code,
      "if (!isUuid(id)) { state = { kind: 'error', message: EXCEPTION_NOT_AVAILABLE_COPY }; } else if (offline) {",
    );
    expect(malformed).toBeLessThan(
      at(code, 'You are offline. This exception needs a connection to load.'),
    );
    expect(code).toContain(
      "const EXCEPTION_NOT_AVAILABLE_COPY = 'This exception is not available to you, or it no longer exists.';",
    );
    expect(load).toContain(
      "if (status === 404) { setState({ kind: 'error', message: EXCEPTION_NOT_AVAILABLE_COPY }); return; }",
    );
  });

  // Mutation caught: Try again drawn for a malformed id (a read that is never sent).
  it('draws Try again on the error card only for a well-formed id', () => {
    expect(code).toContain(
      '{isUuid(id) ? ( <View style={{ marginTop: 14, alignSelf: \'flex-start\' }}> <Button variant="outline" size="sm" onPress={() => void refresh()}> Try again </Button> </View> ) : null}',
    );
  });
});

// ── Scan tab ─────────────────────────────────────────────────────────────

describe('scan tab: only a uuid after an item-label path is read by id', () => {
  const code = codeOnly(sourceOf(SCAN_TAB));

  // Mutation caught: the loose 36-character pattern back in the screen.
  it('takes the label id from the shared strict parser', () => {
    expect(code).not.toContain('[0-9a-f-]{36}');
    expect(code).not.toMatch(/function parseItemId\(/);
    expect(code).toContain("import { parseItemId } from '@/lib/scan-item-label';");
    expect(code).toContain('const directId = parseItemId(data);');
  });
});

// ── Why the screens are the last check ───────────────────────────────────

describe('the link rewrite passes a 36-character near-miss on to the screen', () => {
  // Documentation, true before and after B65: the rewrite's id group is loose
  // on purpose (open question 6), so the screen's own check is the last one.
  // Update this when the rewrite is ever tightened.
  it('rewrites an order path with 36 hyphens to the order screen', () => {
    const dashes = '-'.repeat(36);
    expect(rewriteWebPath(`/dashboard/orders/${dashes}`)).toBe(`/order/${dashes}`);
  });
});
