import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attrText,
  hasContent,
  parseTsx,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * F2-3 CALL-SITE PINS (put away and partial fulfilment from the order). The
 * order screen, the Staging tab and the sheets import native modules, so
 * vitest cannot render them; every decision lives in a tested module
 * (lib/order-put-away.ts, lib/order-partial.ts, lib/staging-worklist.ts,
 * lib/orders-api.ts, and core), and these pins keep the screens wired to
 * them. Each names the mutation it catches.
 *
 *   - Approve partial and Resume open the preview sheet; its confirm is the
 *     existing transition, then readiness read again, and the message is
 *     computed from that read;
 *   - "Put away" on a readiness line and "Put away N items" on the card open
 *     the Staging tab filtered to those items, for stock:transfer only;
 *   - the order screen reads readiness again whenever it is back in focus;
 *   - the Staging tab reads its params and never rewrites them, shows the
 *     chip, and goes back to the order;
 *   - the sheet is the sibling-backdrop shape, every control its own
 *     VoiceOver element, 44 pt, labels capped.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(MOBILE_ROOT, file), 'utf8');

const SCREEN_FILE = 'app/order/[id].tsx';
const STAGING_FILE = 'app/(drawer)/staging.tsx';
const SHEET_FILE = 'src/components/approve-partial-sheet.tsx';
const SUMMARY_FILE = 'src/components/order-readiness-summary.tsx';
const LINE_FILE = 'src/components/order-line-readiness.tsx';
const screen = read(SCREEN_FILE);
const staging = read(STAGING_FILE);
const sheet = read(SHEET_FILE);
const summary = read(SUMMARY_FILE);
const lineCard = read(LINE_FILE);

/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A node's text with its comments dropped, whitespace collapsed and
 *  trailing commas removed (a reformat cannot break a pin). */
function flat(node: ts.Node, sf: ts.SourceFile): string {
  return codeOnly(node.getText(sf))
    .replace(/\s+/g, ' ')
    .replace(/,(\s*[)}\]])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** Every call of `name(...)` in a file. */
function callsOf(src: string, file: string, name: string): { call: ts.CallExpression; sf: ts.SourceFile }[] {
  const sf = parseTsx(src, file);
  const out: { call: ts.CallExpression; sf: ts.SourceFile }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      out.push({ call: n, sf });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The onPress (third argument) of the screen's actionBtn with this label. */
function actionPress(label: string): string {
  const hits = callsOf(screen, SCREEN_FILE, 'actionBtn').filter(({ call }) => {
    const first = call.arguments[0];
    return first !== undefined && ts.isStringLiteral(first) && first.text === label;
  });
  expect(hits, `actionBtn('${label}')`).toHaveLength(1);
  const { call, sf } = hits[0]!;
  return flat(call.arguments[2]!, sf);
}

/** The body of a function declared in a file (`function name(` or `async function name(`). */
function functionBody(src: string, file: string, name: string): string {
  const sf = parseTsx(src, file);
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = flat(n.body, sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found, `function ${name}`).not.toBeNull();
  return found!;
}

/** Every JSX element with this tag, with its ancestors. */
function elements(src: string, file: string, tag: string) {
  const sf = parseTsx(src, file);
  const out: { el: JsxNode; ancestors: JsxNode[]; sf: ts.SourceFile }[] = [];
  walkJsx(sf, (el, ancestors) => {
    if (tagOf(el, sf) === tag) out.push({ el, ancestors: [...ancestors], sf });
  });
  return out;
}

describe('Approve partial and Resume open the preview first', () => {
  // Mutation caught (each): committing straight from the button again, with
  // no preview.
  it.each([
    ['Approve partial', "() => openPartialSheet('approve_partial')"],
    ['Resume fulfillment', "() => openPartialSheet('resume')"],
  ])('%s', (label, press) => {
    expect(actionPress(label)).toBe(press);
  });

  it('nothing reaches approve_partial or resume_fulfillment another way (the one route is the sheet’s confirm)', () => {
    const code = codeOnly(screen);
    expect(code).not.toContain("action: 'approve_partial'");
    expect(code).not.toContain("action: 'resume_fulfillment'");
    expect(code.match(/\bcommitPartialFulfilment\b/g)).toHaveLength(2); // imported + passed
    expect(code.match(/\bconfirmPartial\b/g)).toHaveLength(2); // declared + the sheet's onConfirm
  });

  // Mutation caught: a preview recomputed on every render (the commit's own
  // reload would swap the numbers under the reader), or a per-line preview.
  it('the preview is core’s, over the readiness on screen, frozen when the sheet opens', () => {
    expect(functionBody(screen, SCREEN_FILE, 'openPartialSheet')).toBe(
      '{ if (acting !== null || !order) return; setPartial({ action, preview: previewPartialFulfilment(order.readiness, action) }); }',
    );
  });

  // Mutation caught: saying the preview's number (echo), reading before the
  // commit, or dropping the re-read.
  it('confirm: the existing transition, readiness read again beside the reload, and the message from that read', () => {
    expect(functionBody(screen, SCREEN_FILE, 'confirmPartial')).toBe(
      "{ if (!id || !partial) return; const { action, preview } = partial; setActing(action === 'approve_partial' ? 'approve-partial' : 'resume'); try { const result = await runPartialFulfilment({ commit: commitPartialFulfilment, reread: (orderId) => readOrderReadiness(supabase, orderId), reload: load }, id, action, preview); setPartial(null); Alert.alert(PARTIAL_ACTION_TITLE[action], result.text); } finally { setActing(null); } }",
    );
  });

  it('the sheet shows core’s words for the frozen preview, knows when the phone is offline, and confirms through confirmPartial', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(
      /\{partial \? \(\s*<ApprovePartialSheet\s+visible\s+view=\{partialSheetView\(partial\.preview, \{\s*timeZone: order\?\.orgTimezone \?\? undefined,\s*orderStatus: order\?\.status \?\? null,\s*\}\)\}\s+offline=\{offline\}\s+onClose=\{\(\) => setPartial\(null\)\}\s+onConfirm=\{confirmPartial\}\s*\/>\s*\) : null\}/,
    );
  });

  it('the buttons keep their gates (disabled with core’s reason; offline, every action waits for a connection)', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(
      /'Approve partial',\s*'approve-partial',[\s\S]*?stockGates\.approvePartial === 'disabled',\s*stockGates\.notice,\s*\)/,
    );
    expect(code).toMatch(/'Resume fulfillment',\s*'resume',[\s\S]*?stockGates\.resume === 'disabled',\s*stockGates\.notice,\s*\)/);
  });
});

describe('Put away from the order', () => {
  // Mutation caught: a gate other than the one Place asserts, or offering
  // put-away to the requester's one-sentence card.
  it('the gate is stock:transfer and items:read (Place and the Staging route), and only the full panel offers it', () => {
    const code = codeOnly(screen);
    expect(code).toContain('const { canTransfer, canReadItems } = putAwayAccessFor(role, permissions);');
    expect(code).toMatch(
      /orderPutAwayView\(\{\s*readiness: order\?\.readiness \?\? null,\s*fullPanel: showLineReadiness,\s*access: \{ canTransfer, canReadItems \},\s*\}\)/,
    );
    expect(code).toMatch(/\[order, showLineReadiness, canTransfer, canReadItems\]/);
  });

  it('"Put away N items" on the card, and "Put away" on each line, open the same filtered Staging tab', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(
      /putAway=\{\s*putAway\.strip\.kind !== 'none'\s*\? \{ offer: putAway\.strip, disabled: acting !== null, onPress: openPutAway \}\s*: null\s*\}/,
    );
    expect(code).toMatch(
      /const lineOffer =\s*lineReadiness && l\.orderRequestLineId\s*\? \(putAway\.lines\.get\(l\.orderRequestLineId\) \?\? null\)\s*: null;/,
    );
    expect(code).toMatch(
      /putAway=\{\s*lineOffer\s*\? \{\s*offer: lineOffer,\s*disabled: offline \|\| acting !== null,\s*offline,\s*onPress: openPutAway,\s*\}\s*: null\s*\}/,
    );
    // Mutation caught: a hand-built route (URLSearchParams has no working
    // get() on the phone), or navigating offline to a list that cannot load.
    expect(functionBody(screen, SCREEN_FILE, 'openPutAway')).toBe(
      '{ if (!order || offline || itemIds.length === 0) return; router.push(stagingPutAwayRoute(order.id, itemIds)); }',
    );
  });

  // Mutation caught: dropping the focus reload (back from Staging, the
  // readiness would still show the stock in Staging).
  it('the order screen reads the order, and its readiness, again whenever it is back in focus', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(/useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\),\s*\);/);
    const loadStart = code.indexOf('const load = React.useCallback(async () => {');
    expect(code.indexOf('readOrderReadiness(supabase, id)', loadStart)).toBeGreaterThan(loadStart);
  });

  it('the card’s button: core’s label, 44 pt, disabled offline (and says so) or while anything runs; the sentence otherwise', () => {
    const s = codeOnly(summary);
    expect(s).toMatch(
      /\{putAway && putAwayOffer\?\.kind === 'link' \? \(\s*<Button\s+size="sm"\s+variant="outline"\s+disabled=\{offline \|\| putAway\.disabled\}\s+onPress=\{\(\) => putAway\.onPress\(putAwayOffer\.itemIds\)\}\s+accessibilityHint=\{\s*offline \? READINESS_NEEDS_CONNECTION_COPY : PUT_AWAY_STRIP_HINT\s*\}\s+style=\{\{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP \}\}\s*>\s*\{putAwayOffer\.label\}/,
    );
    expect(s).toMatch(/: putAwayOffer\?\.kind === 'needs_permission' \? \(\s*<Body size=\{12\.5\} muted>\s*\{putAwayOffer\.message\}/);
  });

  it('a line’s button is named for what it moves ("Put away 4 of Maus I from Staging"), 44 pt, and never inside the state row', () => {
    const s = codeOnly(lineCard);
    expect(s).toMatch(
      /\{putAway \? \(\s*<Button\s+size="sm"\s+variant="outline"\s+disabled=\{putAway\.disabled\}\s+onPress=\{\(\) => putAway\.onPress\(putAway\.offer\.itemIds\)\}\s+accessibilityLabel=\{putAwayLineAccessibilityLabel\(line\)\}\s+accessibilityHint=\{putAway\.offline \? READINESS_NEEDS_CONNECTION_COPY : undefined\}\s+style=\{\{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP \}\}\s*>\s*\{putAway\.offer\.label\}/,
    );
    const buttons = elements(lineCard, LINE_FILE, 'Button');
    expect(buttons).toHaveLength(1);
    const { ancestors, sf } = buttons[0]!;
    // A touchable ancestor would fold it into the row's one VoiceOver element.
    expect(ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
    expect(ancestors.some((a) => attrText(a, 'accessible', sf) !== undefined)).toBe(false);
  });
});

describe('the Staging tab, opened from the order', () => {
  const code = codeOnly(staging);

  it('reads the params with core, and the read is filtered to the order’s items', () => {
    expect(code).toMatch(
      /const routeParams = stagingRouteParamValues\(\s*useLocalSearchParams<\{ itemIds\?: string \| string\[\]; orderId\?: string \| string\[\] \}>\(\),\s*\);/,
    );
    expect(code).toMatch(
      /stagingScreenFilter\(\s*\{ itemIds: routeParams\.itemIds, orderId: routeParams\.orderId \},\s*shownAllFor,\s*\)/,
    );
    expect(code).toContain('const itemFilter = screenFilter.active;');
    expect(code).toContain('stagingWorklistPath(filter, activeWarehouseId, itemFilter)');
    expect(code).toMatch(/\}, \[filter, activeWarehouseId, orgId, itemFilter\]\);/);
  });

  // Pattern #18: a URL rewrite in a mount effect breaks a deep link nobody
  // touched. Mutation caught: any effect, or Show all, rewriting the params.
  it('never rewrites its params: no setParams, no navigation with them, no effect reads them', () => {
    expect(code).not.toMatch(/setParams\(/);
    expect(code).not.toMatch(/router\.(replace|push|navigate)\([^)]*(itemIds|orderId)/);
    const sf = parseTsx(staging, STAGING_FILE);
    const effects: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'useEffect'
      ) {
        effects.push(flat(n, sf));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(effects.length).toBeGreaterThan(0);
    for (const e of effects) {
      expect(e).not.toMatch(/routeParams|itemIds|orderId|shownAllFor|router\./);
    }
    // Show all is the reader's choice, held in state.
    expect(code).toContain('onShowAll={() => setShownAllFor(screenFilter.key)}');
  });

  it('the chip: core’s words (the web page’s chip), the answer’s order, and the empty sentence', () => {
    expect(code).toContain('const chip = stagingFilterChip(itemFilter, orderLink);');
    expect(code).toContain('setOrderLink(parseStagingOrderLink(res));');
    expect(code).toContain('setOrderLink(null);');
    expect(code).toMatch(
      /const filterEmpty = stagingFilterEmptyCopy\(\{\s*active: itemFilter,\s*loading,\s*error,\s*rowCount: rows\.length,\s*\}\);/,
    );
    expect(code).toMatch(
      /\{chip \? \(\s*<StagingFilterChipCard\s+chip=\{chip\}\s+emptyCopy=\{filterEmpty\}\s+onShowAll=\{\(\) => setShownAllFor\(screenFilter\.key\)\}\s+onBack=\{backToOrder\}\s*\/>/,
    );
    expect(code).toMatch(/\{screenFilter\.invalidCopy \? \(\s*<Body size=\{13\} muted>\s*\{screenFilter\.invalidCopy\}/);
  });

  // Mutation caught: the generic "Nothing to place." under a chip that
  // already says the filtered list is empty (two empty messages).
  it('one empty message: a filtered list that came back empty shows only the chip’s sentence', () => {
    expect(code).toMatch(/const listEmpty = stagingListEmptyState\(\{ loading, error, filterEmpty \}\);/);
    expect(code).toMatch(
      /ListEmptyComponent=\{\s*listEmpty === 'loading' \? \([\s\S]*?\) : listEmpty === 'none' \? null : listEmpty === 'error' \? \(/,
    );
  });

  it('the chip says when stock at other warehouses was left out (core’s note, the web page’s)', () => {
    const fn = code.slice(code.indexOf('function StagingFilterChipCard('));
    expect(fn).toMatch(/\{chip\.elsewhereNote \? \(\s*<Body size=\{12\.5\} muted>\s*\{chip\.elsewhereNote\}/);
  });

  // Mutation caught: router.back() (the drawer the order pushed goes to its
  // first screen, Home, before it pops to the order).
  it('Back (the chip’s and the arrow) returns to the order it came from', () => {
    expect(code).toMatch(
      /const backToOrder = \(orderId: string\) =>\s*router\.dismissTo\(\{ pathname: '\/order\/\[id\]', params: \{ id: orderId \} \}\);/,
    );
    expect(code).toMatch(
      /const goBack = \(\) => \{\s*if \(fromOrderId\) \{\s*backToOrder\(fromOrderId\);\s*return;\s*\}\s*if \(router\.canGoBack\(\)\) router\.back\(\);\s*else router\.replace\('\/'\);\s*\};/,
    );
    expect(code).toMatch(
      /const fromOrderId =\s*screenFilter\.parse\.state === 'ok' \? screenFilter\.parse\.filter\.orderId : null;/,
    );
  });

  // After Show all hides the chip, the top-left arrow is the one way back to
  // the order on screen. Mutation caught: an unnamed or 38 pt chip.
  it('the top-left arrow and the menu chip are named for VoiceOver and 44 pt, the bar keeping its place', () => {
    expect(code).toMatch(
      /<IconChip\s+icon=\{ArrowLeft\}\s+onPress=\{goBack\}\s+minTap\s+accessibilityLabel=\{fromOrderId \? STAGING_FILTER_BACK_LABEL : 'Back'\}\s*\/>/,
    );
    expect(code).toContain('<IconChip icon={Menu} onPress={openDrawer} minTap accessibilityLabel="Open menu" />');
    // The 44 pt frame is 3 pt wider than the 38 pt chip on every side: the bar,
    // the gap between the chips and the head each give those 3 pt back.
    expect(code).toMatch(/topbar: \{\s*paddingHorizontal: 9,\s*paddingTop: 5,/);
    expect(code).toMatch(/<View style=\{\{ flexDirection: 'row', alignItems: 'center', gap: 2 \}\}>\s*<IconChip\s+icon=\{ArrowLeft\}/);
    expect(code).toMatch(/head: \{\s*paddingHorizontal: 20,\s*paddingTop: 9,/);
  });

  it('Place is unchanged: the put-away sheet with its source fixed, crates seeded from the book’s storage', () => {
    expect(code).toContain('putAwaySourceLocationId={placing.sourceLocationId}');
    expect(code).toContain('bookStorage={placing.bookStorage}');
    expect(code).toContain('canCreateLocation={canCreateLocation}');
  });

  it('the chip’s two actions are 44 pt buttons, named, labels capped at the control ceiling', () => {
    const fn = code.slice(code.indexOf('function StagingFilterChipCard('));
    expect(fn).toMatch(
      /<Pressable\s+onPress=\{onPress\}\s+accessibilityRole="button"\s+accessibilityLabel=\{label\}\s+accessibilityHint=\{hint\}\s+style=\{\(\{ pressed \}\) => \(\{\s*minHeight: MIN_TAP,/,
    );
    expect(fn).toContain('maxFontSizeMultiplier={CHIP_ACTION_CAP}');
    expect(code).toContain('const CHIP_ACTION_CAP = capTo(12.5, TYPE_CEILING.control);');
  });
});

describe('the approve-partial sheet (sibling backdrop, VoiceOver, 44 pt, Dynamic Type)', () => {
  const sf = parseTsx(sheet, SHEET_FILE);
  const all: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(sf, (el, ancestors) => all.push({ el, ancestors: [...ancestors] }));
  const container = all.find((n) => attrText(n.el, 'accessibilityViewIsModal', sf) === 'true')!;
  const kids = (el: JsxNode): JsxNode[] =>
    ts.isJsxElement(el)
      ? el.children.filter(
          (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
            ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
        )
      : [];

  it('the container keeps VoiceOver inside and holds exactly [scrim, card]', () => {
    expect(container).toBeDefined();
    expect(tagOf(container.el, sf)).toBe('View');
    expect(attrText(container.el, 'onAccessibilityEscape', sf)).toBe('requestClose');
    const [scrim, card, ...rest] = kids(container.el);
    expect(rest).toEqual([]);
    expect(tagOf(scrim!, sf)).toBe('Pressable');
    expect(hasContent(scrim!)).toBe(false);
    expect(attrText(scrim!, 'onPress', sf)).toBe('requestClose');
    expect(attrText(scrim!, 'onAccessibilityTap', sf)).toBe('requestClose');
    expect(attrText(scrim!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim!, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(scrim!, 'style', sf)).toContain('StyleSheet.absoluteFill');
    expect(tagOf(card!, sf)).toBe('View');
    for (const prop of ['onPress', 'accessible', 'onStartShouldSetResponder']) {
      expect(attrText(card!, prop, sf)).toBeUndefined();
    }
  });

  it('every control in the card is its own button with a name and at least 44 pt', () => {
    const card = kids(container.el)[1]!;
    const presses = all.filter((n) => n.ancestors.includes(card) && tagOf(n.el, sf) === 'Pressable');
    expect(presses.length).toBe(3); // the X, Confirm, Cancel
    for (const p of presses) {
      expect(attrText(p.el, 'accessibilityRole', sf)).toBe('button');
      expect(attrText(p.el, 'accessibilityLabel', sf)).toBeDefined();
      // No touchable or accessible ancestor between the card and the control.
      const above = p.ancestors.slice(p.ancestors.indexOf(card));
      expect(above.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
      const style = attrText(p.el, 'style', sf) ?? '';
      expect(style.includes('MIN_TAP') || style.includes('styles.action')).toBe(true);
    }
    expect(codeOnly(sheet)).toMatch(/action: \{[^}]*minHeight: MIN_TAP,/);
  });

  it('each item is one VoiceOver element in core’s words; the summary, note and error are read in place', () => {
    const code = codeOnly(sheet);
    expect(code).toMatch(/<View\s+key=\{item\.itemId\}\s+accessible\s+accessibilityLabel=\{item\.accessibilityLabel\}/);
    expect(code).toContain('{view.summary}');
    expect(code).toContain('{view.checkedAt}');
    expect(code).toContain('{view.note}');
    expect(code).toContain('{view.unavailable}');
    // Pattern #20: a refusal stays on the sheet, announced (iOS gives the
    // 'alert' role no trait), never only a toast.
    expect(code).toMatch(/<Body size=\{13\} color=\{ACCENT\.crit\} accessibilityRole="alert">\s*\{error\}/);
    expect(functionBody(sheet, SHEET_FILE, 'confirm')).toBe(
      '{ if (!canConfirm) return; setBusy(true); setError(null); try { await onConfirm(); } catch (e) { const message = describePartialCommitError(e); setError(message); AccessibilityInfo.announceForAccessibility(message); } finally { setBusy(false); } }',
    );
  });

  it('nothing to confirm on an unavailable preview; offline Confirm is disabled and says why; no dismissing mid-commit', () => {
    const code = codeOnly(sheet);
    expect(code).toContain('const confirmLabel = movedOn ? null : view.confirmLabel;');
    expect(code).toContain('const canConfirm = confirmLabel !== null && !offline && !busy;');
    expect(code).toMatch(/\{confirmLabel !== null \? \(\s*<Pressable\s+onPress=\{\(\) => void confirm\(\)\}\s+disabled=\{!canConfirm\}/);
    expect(code).toContain('accessibilityHint={offline ? READINESS_NEEDS_CONNECTION_COPY : undefined}');
    expect(functionBody(sheet, SHEET_FILE, 'requestClose')).toBe('{ if (busy) return; onClose(); }');
  });

  // Mutation caught: Confirm left on after the screen reloaded and the order
  // had moved on (the RPC would refuse it again), or taken away mid-commit
  // (the commit's own reload lands before its result is said).
  it('the order moved on under the sheet: Close instead of Confirm, never while a commit runs, and says why unless a refusal already did', () => {
    const code = codeOnly(sheet);
    expect(code).toContain('const movedOn = view.movedOn !== null && !busy;');
    expect(code).toMatch(/\{movedOn && !error \? \(\s*<Body size=\{13\.5\} color=\{ACCENT\.warn\}>\s*\{view\.movedOn\}/);
    expect(code).toContain('const closeLabel = movedOn ? PARTIAL_CLOSE_LABEL : view.cancelLabel;');
    expect(code).toMatch(/accessibilityLabel=\{closeLabel\}/);
    expect(code).toMatch(/maxFontSizeMultiplier=\{ACTION_CAP\}>\s*\{closeLabel\}/);
  });

  // Walk D2: after the order moved on, the preview ("holds 2 of 3 units now")
  // stayed above the sentence although someone else had approved the order.
  // Mutation caught: the preview kept once Close replaced Confirm.
  it('once the order moved on, the stale preview goes and only the sentence and Close stay', () => {
    const code = codeOnly(sheet);
    expect(code).toMatch(/\{movedOn \? null : \(\s*<ScrollView style=\{\{ maxHeight: bodyMaxHeight \}\}/);
    // Everything the preview says is inside that ScrollView.
    const body = code.slice(code.indexOf('<ScrollView'), code.indexOf('</ScrollView>'));
    for (const word of ['{view.summary}', 'view.items.map', '{view.note}', '{view.checkedAt}', '{view.unavailable}']) {
      expect(body).toContain(word);
    }
  });

  it('button labels stop growing at the control ceiling; the sentences grow', () => {
    const code = codeOnly(sheet);
    expect(code).toContain('const ACTION_CAP = capTo(13, TYPE_CEILING.control);');
    expect(code.match(/maxFontSizeMultiplier=\{ACTION_CAP\}/g)).toHaveLength(2);
    // Content text is never capped here.
    expect(code).not.toMatch(/<Body[^>]*maxFontSizeMultiplier/);
  });
});
