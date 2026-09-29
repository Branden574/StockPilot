import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { BOOK_COVER_PLACEHOLDER, BOOK_COVER_UNAVAILABLE } from '@stockpilot/core';

import {
  TOUCHABLE_TAG,
  attrText,
  hasContent,
  parseTsx,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { bookCoverPlaceholderLabel } from './book-order-totals-view';

/**
 * BOOK ORDER TOTALS on the phone: WIRING PINS (plan 13.4).
 *
 * The screens cannot render under this node test environment (vitest runs
 * src/** only; app/ imports native modules at load), so the load-bearing
 * wiring is pinned at source level. The logic is pure and tested in
 * book-order-totals-api.test.ts, book-order-totals-view.test.ts,
 * report-export-download.test.ts and book-order-totals-link.test.ts. Each
 * pin is a rule the owner set or the plan requires:
 *   1. totals come ONLY from the API: no Supabase read, no RPC, no sum on the
 *      phone;
 *   2. a failure is shown as a failure, never zeros or an empty report, and
 *      offline shows only the exact answer with its time;
 *   3. only the newest answer lands, for the workspace and account on screen;
 *   4. the drill-down and the export use the query of the answer on screen
 *      (one concrete warehouse for the row, its orders and the file);
 *   5. export is iOS-only (share), Android is offered the web;
 *   6. an order opens only when the server says so;
 *   7. the Reports entry sits outside the figures' loading branch, and a
 *      failed figure read never shows zeros;
 *   8. every touchable has a role and words.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');

/** Source with comments stripped, so a header that names what a screen
 *  avoids cannot satisfy or trip a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A number in the file's StyleSheet.create({...}): `styles.<key>.<prop>`,
 *  a literal or a `const NAME = <number>` in the same file. */
function styleNumber(sf: ts.SourceFile, key: string, prop: string): number | undefined {
  let out: number | undefined;
  const consts = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isNumericLiteral(node.initializer)) consts.set(node.name.text, Number(node.initializer.text));
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === 'StyleSheet.create' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const style of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(style) || style.name.getText(sf) !== key) continue;
        if (!ts.isObjectLiteralExpression(style.initializer)) continue;
        for (const p of style.initializer.properties) {
          if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== prop) continue;
          const v = p.initializer;
          out = ts.isNumericLiteral(v) ? Number(v.text) : ts.isIdentifier(v) ? consts.get(v.text) : undefined;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const LIST = 'app/reports/book-order-totals/index.tsx';
const ORDERS = 'app/reports/book-order-totals/[itemId].tsx';
const list = codeOnly(read(LIST));
const orders = codeOnly(read(ORDERS));
const reports = codeOnly(read('src/screens/reports.tsx'));
const layout = read('app/_layout.tsx');
const paginator = codeOnly(read('src/components/ui/paginator.tsx'));

describe('1. totals come only from the API', () => {
  it.each([
    [LIST, list],
    [ORDERS, orders],
  ])('%s never reads Supabase and never adds figures', (_file, src) => {
    expect(src).not.toMatch(/supabase/);
    expect(src).not.toMatch(/\.rpc\(/);
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/sumReportQuantities/);
    expect(src).not.toMatch(/from '@\/lib\/db'/);
  });

  it('the list reads through getBookOrderTotals and the drill-down through getBookOrderOrders', () => {
    expect(list).toContain('await getBookOrderTotals(forOrg, target, ctrl.signal)');
    expect(orders).toContain('await getBookOrderOrders(forOrg, book, request, targetPage, ctrl.signal)');
  });

  it('the summary and grand total are printed from the answer, not the page', () => {
    expect(list).toContain('bookReportGrandTotalLine(answer.summary, totalPages)');
    expect(list).toContain('const s = answer.summary;');
    expect(orders).toContain('bookReportDrawerHeader(book, answer.totals)');
  });
});

describe('2. failures and offline', () => {
  it('a failed read is stored as the failure (never an empty answer)', () => {
    expect(list).toContain("setStored((prev) => bookReportFailure(prev, targetKey, e, 'report'));");
    expect(orders).toContain("setStored((prev) => bookReportFailure(prev, targetKey, e, 'orders'));");
    expect(list).toContain('{BOOK_REPORT_LOAD_ERROR}');
    expect(orders).toContain('{BOOK_REPORT_ORDERS_LOAD_ERROR}');
  });

  it('what is shown is bookReportView for the exact key, with the phone offline state', () => {
    expect(list).toContain('const view = bookReportView(stored, key, offline);');
    expect(orders).toContain('const view = bookReportView(stored, key, offline);');
    expect(list).toContain('const offline = isOfflineState(useNetworkState());');
    expect(orders).toContain('const offline = isOfflineState(useNetworkState());');
  });

  it('nothing is asked offline, and every answer is remembered under its served key', () => {
    expect(list).toMatch(/if \(offline \|\| !key \|\| !orgId \|\| !userId\) return;/);
    expect(list).toContain('rememberBookReport(servedKey, next);');
    expect(orders).toContain('rememberBookReport(servedKey, { answer });');
  });

  it('the empty state is said only for a real answer with no books', () => {
    expect(list).toContain('answer && answer.totalCount === 0 ?');
    expect(list).toContain('{BOOK_REPORT_EMPTY}');
  });
});

describe('3. only the newest answer, for this workspace and account', () => {
  it.each([
    [LIST, list],
    [ORDERS, orders],
  ])('%s checks isCurrentBookReportAnswer with the epoch captured at request time', (_file, src) => {
    expect(src).toContain('const epoch = accountEpoch();');
    expect(src).toMatch(
      /isCurrentBookReportAnswer\(answer, \{\s+isNewestRequest: token === seq\.current,\s+activeOrgId: orgRef\.current,\s+epochAtRequest: epoch,\s+\}\)/,
    );
  });

  it('a workspace switch resets the list and aborts the request still out', () => {
    expect(list).toMatch(/if \(switched\) \{\s+setQuery\(defaultQuery\(\)\);/);
    expect(list).toContain('return () => pending.current?.abort();');
    expect(list).toContain('inFlight.current?.abort();');
  });

  it('the drill-down never re-asks under another workspace', () => {
    expect(orders).toContain('const key = switched ? null : bookReportOrdersKey(');
  });
});

describe('4. one concrete warehouse for the row, its orders and the file', () => {
  it('requests are built from resolveBookReportRequest (never "default")', () => {
    expect(list).toContain('resolveBookReportRequest(query, viewWarehouse)');
    expect(list).toContain("const viewWarehouse = query.warehouse === 'default' ? ws.activeWarehouseId : null;");
  });

  it("the drill-down and the export use the answer's own query", () => {
    expect(list).toContain('router.push(bookReportDrillDownHref(item.itemId, data.query) as Href)');
    expect(list).toContain('path: bookReportExportPath(choice.format, choice.photos, source.query),');
    expect(list).toContain('onChoose={(choice) => void runExport(choice, data)}');
    expect(orders).toContain('bookReportQueryFromListParams(params)');
  });
});

describe('5. export by platform (plan gap 11)', () => {
  it('Export in the header only for reports:export on iOS', () => {
    expect(list).toContain("const canExport = showWriteCtaForRole(role, perms, 'reports:export');");
    expect(list).toContain('const exportMode = bookReportExportMode(Platform.OS);');
    expect(list).toMatch(/onExport=\{\s+canExport && exportMode === 'share' && data/);
  });

  it('Android gets the words and the web link instead, never Share', () => {
    expect(list).toContain("{canExport && exportMode === 'web_only' ? (");
    expect(list).toContain('{BOOK_REPORT_EXPORT_ANDROID}');
    expect(list).toContain('{BOOK_REPORT_OPEN_ON_WEB}');
    expect(list).toContain('Linking.openURL(bookReportWebUrl(API_BASE, data.query))');
    expect(list).not.toMatch(/Share\.share/);
  });

  it('the export sheet gets the result size, so the cover limit is said before export (gap 12)', () => {
    expect(list).toContain('totalCount={data.answer.totalCount}');
    const sheet = codeOnly(read('src/components/book-order-export-sheet.tsx'));
    expect(sheet).toContain('const offer = bookReportExportOffer(totalCount);');
    expect(sheet).toContain('{offer.coverCapNote ? (');
  });
});

describe('6. drill-down order links (plan gap 7)', () => {
  const sf = parseTsx(read(ORDERS), ORDERS);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'OrderRow',
  )!;

  it('a row is a button only when the presentation has a link', () => {
    const src = fn.getText(sf);
    expect(src).toMatch(/if \(p\.href\) \{[\s\S]*<Pressable[\s\S]*onPress=\{\(\) => onOpen\(href\)\}/);
    expect(orders).toContain('p: bookReportOrderRowPresentation(row, book, statusLabels),');
  });

  it('otherwise it is words with role text and the reason, with no onPress anywhere', () => {
    const els: JsxNode[] = [];
    walkJsx(fn, (el) => els.push(el));
    const plain = els.find(
      (el) => tagOf(el, sf) === 'View' && attrText(el, 'accessibilityRole', sf) === 'text',
    )!;
    expect(plain).toBeTruthy();
    expect(attrText(plain, 'accessibilityHint', sf)).toBe('p.accessibilityHint');
    expect(attrText(plain, 'onPress', sf)).toBeUndefined();
    const inside: JsxNode[] = [];
    walkJsx(plain, (el) => inside.push(el));
    expect(inside.filter((el) => el !== plain && TOUCHABLE_TAG.test(tagOf(el, sf)))).toEqual([]);
  });
});

describe('7. the shared Reports screen', () => {
  it('the entry sits before, and outside, the figures’ loading branch', () => {
    const entry = reports.indexOf('{showBookReport ? (');
    const kpi = reports.indexOf('{kpiFailed ? (');
    const spinner = reports.indexOf(') : loading || !summary ? (');
    expect(entry).toBeGreaterThan(-1);
    expect(kpi).toBeGreaterThan(entry);
    expect(spinner).toBeGreaterThan(kpi);
    // The entry's own branch closes before the figures' branch opens.
    expect(reports.slice(entry, kpi)).toMatch(/\) : null\}\s*$/);
    expect(reports).toContain("router.push('/reports/book-order-totals' as Href)");
  });

  it('the entry follows reports:read and both modules (one rule, tested in the view module)', () => {
    expect(reports).toMatch(/showBookReportEntry\(\{\s+modules,\s+perms,/);
  });

  it('a failed figure read says so and never shows zeros', () => {
    expect(reports).toContain('if (results.some((r) => r.error)) {');
    expect(reports.indexOf('if (results.some((r) => r.error)) {')).toBeLessThan(
      reports.indexOf("kind: 'ready',"),
    );
    expect(reports).toContain('{BOOK_REPORT_KPI_LOAD_ERROR}');
    expect(reports).not.toContain('setLoading(');
  });

  it('no workspace no longer spins forever', () => {
    expect(reports).toContain('const kpiFailed = orgId ? current?.kind === \'error\' : !workspaceLoading;');
    expect(reports).toContain('else await retryWorkspace();');
  });

  it('the menu chip has words and a 44pt target', () => {
    expect(reports).toContain('<IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />');
  });

  it('the drawer route and the tab render the same screen', () => {
    expect(read('app/(drawer)/reports.tsx')).toContain("export { default } from '@/screens/reports';");
    expect(read('app/(drawer)/(tabs)/reports-tab.tsx')).toContain("export { default } from '@/screens/reports';");
  });
});

describe('routes', () => {
  it('both screens are root Stack cards', () => {
    expect(layout).toContain('<Stack.Screen name="reports/book-order-totals/index" options={{ presentation: \'card\' }} />');
    expect(layout).toContain('<Stack.Screen name="reports/book-order-totals/[itemId]" options={{ presentation: \'card\' }} />');
  });
});

describe('8. accessibility', () => {
  it('Paginator buttons have a role, words and state', () => {
    expect(paginator).toContain('accessibilityLabel={`Page ${num}`}');
    expect(paginator).toContain('accessibilityState={{ selected: active }}');
    expect(paginator).toContain("accessibilityLabel={direction === 'prev' ? 'Previous page' : 'Next page'}");
    expect(paginator).toContain('accessibilityState={{ disabled: Boolean(disabled) }}');
    expect((paginator.match(/accessibilityRole="button"/g) ?? []).length).toBe(2);
  });

  it.each([LIST, ORDERS, 'src/components/book-order-filters-sheet.tsx', 'src/components/book-order-export-sheet.tsx', 'src/components/book-cover.tsx'])(
    'every touchable in %s has a role and words',
    (file) => {
      const sf = parseTsx(read(file), file);
      const missing: string[] = [];
      walkJsx(sf, (el) => {
        if (!TOUCHABLE_TAG.test(tagOf(el, sf))) return;
        const role = attrText(el, 'accessibilityRole', sf);
        const label = attrText(el, 'accessibilityLabel', sf);
        const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;
        if (!role || !label) missing.push(`${file}:${line}`);
      });
      expect(missing).toEqual([]);
    },
  );

  it.each(['src/components/book-order-filters-sheet.tsx', 'src/components/book-order-export-sheet.tsx'])(
    '%s is a sibling-backdrop sheet VoiceOver can use',
    (file) => {
      const sf = parseTsx(read(file), file);
      const containers: JsxNode[] = [];
      walkJsx(sf, (el) => {
        if (attrText(el, 'accessibilityViewIsModal', sf) === 'true') containers.push(el);
      });
      expect(containers).toHaveLength(1);
      const container = containers[0]!;
      expect(attrText(container, 'onAccessibilityEscape', sf)).toBeTruthy();
      const kids = ts.isJsxElement(container)
        ? container.children.filter(
            (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
              ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
          )
        : [];
      expect(kids).toHaveLength(2);
      const [scrim, card] = kids as [JsxNode, JsxNode];
      expect(tagOf(scrim, sf)).toBe('Pressable');
      expect(hasContent(scrim)).toBe(false);
      expect(attrText(scrim, 'accessibilityLabel', sf)).toBe('Close');
      expect(attrText(scrim, 'onAccessibilityTap', sf)).toBe(attrText(scrim, 'onPress', sf));
      expect(attrText(scrim, 'style', sf)).toContain('StyleSheet.absoluteFill');
      expect(tagOf(card, sf)).toBe('View');
      expect(attrText(card, 'onPress', sf)).toBeUndefined();
    },
  );

  it('a 400 for a warehouse or category the reader cannot see drops it, says the filters were reset, and reads again', () => {
    expect(list).toContain('const unreadable = bookReportUnreadableFilter(e);');
    expect(list).toContain(
      'if (unreadable && bookReportWithoutUnreadableFilter(target, unreadable)) {',
    );
    expect(list).toContain('setLinkWasReset(true);');
    expect(list).toContain(
      'setQuery((q) => bookReportWithoutUnreadableFilter(q, unreadable) ?? q);',
    );
  });

  it('covers are contained, never cropped, with a spoken placeholder', () => {
    const cover = codeOnly(read('src/components/book-cover.tsx'));
    expect(cover).toContain('contentFit="contain"');
    expect(cover).toContain('accessibilityLabel={bookCoverAlt(title)}');
    expect(cover).toContain('onError={() => setFailedUri(uri)}');
    expect(codeOnly(read(LIST))).toContain('failed={coverFailed}');
    expect(codeOnly(read(ORDERS))).toContain('failed={coverFailed}');
  });

  // Simulator walk D1: every book WITHOUT a cover was announced "Cover could
  // not be loaded" (failedUri null === uri null). The placeholder's label is
  // read from the component itself and evaluated for each state the
  // placeholder is drawn in, so a rewrite of the expression is still held to
  // what VoiceOver says.
  it("the placeholder says 'No cover' for a book without one, and 'Cover could not be loaded' only after a real failure", () => {
    const file = 'src/components/book-cover.tsx';
    const sf = parseTsx(read(file), file);
    const placeholders: string[] = [];
    walkJsx(sf, (el) => {
      if (tagOf(el, sf) !== 'View' || attrText(el, 'accessibilityRole', sf) !== 'image') return;
      const label = attrText(el, 'accessibilityLabel', sf);
      if (label && label !== 'bookCoverAlt(title)') placeholders.push(label);
    });
    expect(placeholders).toHaveLength(1);
    const say = new Function(
      'failed',
      'failedUri',
      'uri',
      'BOOK_COVER_UNAVAILABLE',
      'BOOK_COVER_PLACEHOLDER',
      'bookCoverPlaceholderLabel',
      `return (${placeholders[0]});`,
    ) as (...args: unknown[]) => string;
    const spoken = (state: { failed: boolean; failedUri: string | null; uri: string | null }) =>
      say(
        state.failed,
        state.failedUri,
        state.uri,
        BOOK_COVER_UNAVAILABLE,
        BOOK_COVER_PLACEHOLDER,
        bookCoverPlaceholderLabel,
      );
    const url = 'https://example.test/cover.jpg';
    expect(spoken({ failed: false, failedUri: null, uri: null })).toBe('No cover');
    expect(spoken({ failed: true, failedUri: null, uri: null })).toBe('Cover could not be loaded');
    expect(spoken({ failed: false, failedUri: url, uri: url })).toBe('Cover could not be loaded');
    expect(spoken({ failed: false, failedUri: url, uri: null })).toBe('No cover');
  });

  // Simulator walk L1: the search field's own frame was 40 pt inside a 44 pt
  // box, so the box's edge did not focus it and VoiceOver outlined 40 pt.
  it('the search field itself is at least 44 pt tall', () => {
    const sf = parseTsx(read(LIST), LIST);
    let input: JsxNode | undefined;
    walkJsx(sf, (el) => {
      if (tagOf(el, sf) === 'TextInput' && attrText(el, 'accessibilityLabel', sf) === 'Search books') input = el;
    });
    expect(input).toBeTruthy();
    expect(attrText(input!, 'style', sf)).toMatch(/^\[styles\.searchInput,/);
    expect(styleNumber(sf, 'searchInput', 'minHeight')).toBeGreaterThanOrEqual(44);
  });

  it("the list's cover and row are sibling buttons, never nested", () => {
    const sf = parseTsx(read(LIST), LIST);
    const nested: string[] = [];
    walkJsx(sf, (el, ancestors) => {
      if (!TOUCHABLE_TAG.test(tagOf(el, sf)) && tagOf(el, sf) !== 'BookCover') return;
      if (ancestors.some((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))) {
        nested.push(`${tagOf(el, sf)}@${sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1}`);
      }
    });
    expect(nested).toEqual([]);
  });
});
