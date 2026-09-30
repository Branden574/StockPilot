import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SHORTFALL_PO_PHONE_REVIEW_COPY } from '@stockpilot/core';

import {
  TOUCHABLE_TAG,
  attrText,
  hasContent,
  parseTsx,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { PO_DRAFT_REVIEW_COPY, poIsReviewOnly } from './po-draft-review';

/**
 * F2-5 CALL-SITE PINS: "Draft PO for what is short" on the phone. The order
 * screen, the draft sheet and the PO screen import native modules, so vitest
 * cannot render them; these pins hold each to the tested decisions
 * (order-shortfall-po.test.ts, sheet-fields-reveal.test.ts,
 * orders-api.shortfall-po.test.ts) and to the sheet rules every sheet keeps
 * (sibling backdrop, VoiceOver, 44 pt, Dynamic Type caps, the keyboard).
 * Each names the mutation it catches.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCREEN_FILE = 'app/order/[id].tsx';
const SHEET_FILE = 'src/components/draft-shortfall-po-sheet.tsx';
const SUMMARY_FILE = 'src/components/order-readiness-summary.tsx';
const PO_FILE = 'app/po/[id].tsx';
const LIB_FILE = 'src/lib/order-shortfall-po.ts';

const read = (file: string) => readFileSync(path.join(MOBILE_ROOT, file), 'utf8');

/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** The text between the bracket at `open` and its partner. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}' };
  const close = pairs[src[open]!]!;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === src[open]) depth += 1;
    else if (src[i] === close) depth -= 1;
    if (depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced from ${open}`);
}

/** A node's text, comments dropped, whitespace collapsed, trailing commas
 *  removed (a reformat cannot break a pin). */
function flat(node: ts.Node, sf: ts.SourceFile): string {
  return codeOnly(node.getText(sf))
    .replace(/\s+/g, ' ')
    .replace(/,(\s*[)}\]])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** The flattened body of `function name(` (or `async function name(`) in a file. */
function bodyOf(src: string, file: string, name: string): string {
  const sf = parseTsx(src, file);
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = flat(n.body, sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found, `function ${name} in ${file}`).not.toBeNull();
  return found!;
}

function tree(src: string, file: string) {
  const sf = parseTsx(src, file);
  const all: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(sf, (el, ancestors) => all.push({ el, ancestors: [...ancestors] }));
  const a = (el: JsxNode, name: string) => attrText(el, name, sf);
  return { sf, all, a };
}

const kidsOf = (el: JsxNode): JsxNode[] =>
  ts.isJsxElement(el)
    ? el.children.filter(
        (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement => ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
      )
    : [];

const screenSrc = read(SCREEN_FILE);
const screen = codeOnly(screenSrc);
const sheetSrc = read(SHEET_FILE);
const sheetCode = codeOnly(sheetSrc);
const summary = codeOnly(read(SUMMARY_FILE));
const poSrc = read(PO_FILE);
const po = codeOnly(poSrc);

// ── The order screen ────────────────────────────────────────────────────────

describe('the order screen: who is offered it, and how the sheet opens', () => {
  // Mutations caught: the offer for a staff buyer, without the full panel, at
  // a picked order, or with a module the phone has not confirmed.
  it('the card’s offer is the tested rule, over the readiness the panel shows', () => {
    expect(screen).toContain("const shownReadiness = readinessShown ? (order?.readiness ?? null) : null;");
    expect(screen).toContain("const ordersModuleOn = enabledModules.has('orders');");
    expect(screen).toContain("const purchaseOrdersModuleOn = enabledModules.has('purchase_orders');");
    // Worked out once per change of what it depends on, never per render.
    expect(screen).toMatch(
      /const shortfallOffer = React\.useMemo\(\s*\(\) =>\s*shortfallPoOffer\(\{\s*readiness: shownReadiness,\s*fullPanel: showLineReadiness,\s*isManager,\s*canManagePurchaseOrders: rpBuy,\s*ordersModule: ordersModuleOn,\s*purchaseOrdersModule: purchaseOrdersModuleOn,?\s*\}\),\s*\[shownReadiness, showLineReadiness, isManager, rpBuy, ordersModuleOn, purchaseOrdersModuleOn\],?\s*\);/,
    );
    expect(screen).toMatch(
      /shortfallPo=\{\s*shortfallOffer\.kind !== 'none'\s*\? \{\s*offer: shortfallOffer,\s*disabled: acting !== null,\s*onPress: \(\) => void openShortfallSheet\(\),?\s*\}\s*: null\s*\}/,
    );
  });

  // Mutations caught: the two reads made one after the other (a serial round
  // trip on the tap), the sheet opened offline, the supplier names read for
  // the whole organization (pattern #3) instead of the shown rows' ids, a
  // supplier the fresh rows name left unread, the screen's rows used when a
  // fresh read answered.
  it('opening reads readiness and the shown rows’ supplier names together, then opens on the tested opening', () => {
    expect(bodyOf(screenSrc, SCREEN_FILE, 'openShortfallSheet')).toBe(
      "{ if (!order || !orgId || offline || acting !== null) return; const shown = shortfallSheetOpening(order.readiness, null); if (!shown) return; setActing('shortfall-po'); try { const [fresh, firstNames] = await Promise.all([ readOrderReadiness(supabase, order.id), readShortfallSupplierNames(supabase, { organizationId: orgId, supplierIds: shortfallSupplierIds(shown.view) }) ]); const opening = shortfallSheetOpening(order.readiness, fresh); if (!opening) return; let supplierNames = firstNames; const more = supplierNames ? missingShortfallSupplierIds(opening.view, supplierNames) : []; if (supplierNames && more.length > 0) { const extra = await readShortfallSupplierNames(supabase, { organizationId: orgId, supplierIds: more }); supplierNames = extra ? new Map([...supplierNames, ...extra]) : null; } setShortfallSheet({ orderId: order.id, orderLabel: opening.view.orderNumber, view: opening.view, notice: opening.notice, supplierNames, timeZone: order.orgTimezone }); if (opening.changed) void load(); } finally { setActing(null); } }",
    );
  });

  // Mutation caught: the sheet opened from an effect, a focus or a refresh.
  it('the sheet opens on the card’s tap only', () => {
    expect(count(screen, 'openShortfallSheet(')).toBe(2); // its declaration and the card
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useCallback|useMemo)\(/g;
    for (let m = hooks.exec(screen); m; m = hooks.exec(screen)) {
      expect(balanced(screen, m.index + m[0].length - 1)).not.toMatch(
        /openShortfallSheet|setShortfallSheet\(\{|DraftShortfallPoSheet/,
      );
    }
  });

  it('a created draft opens on the PO screen, the sheet closed first', () => {
    expect(bodyOf(screenSrc, SCREEN_FILE, 'openShortfallDraft')).toBe('{ setShortfallSheet(null); router.push(route); }');
  });

  it('the sheet is mounted per open with what it opened on, knows when the phone is offline, and reloads behind itself', () => {
    expect(screen).toMatch(
      /\{shortfallSheet \? \(\s*<DraftShortfallPoSheet\s+visible\s+orderId=\{shortfallSheet\.orderId\}\s+orderLabel=\{shortfallSheet\.orderLabel\}\s+startView=\{shortfallSheet\.view\}\s+startNotice=\{shortfallSheet\.notice\}\s+supplierNames=\{shortfallSheet\.supplierNames\}\s+timeZone=\{shortfallSheet\.timeZone\}\s+offline=\{offline\}\s+onClose=\{\(\) => setShortfallSheet\(null\)\}\s+onDrafted=\{\(\) => void load\(\)\}\s+onOpenDraft=\{openShortfallDraft\}\s+onRefresh=\{\(\) => void load\(\)\}\s*\/>\s*\) : null\}/,
    );
  });

  // Drafting sends nothing and emails no one (plan section 2, rule 5).
  it('nothing on this path composes or opens mail', () => {
    for (const fn of ['openShortfallSheet', 'openShortfallDraft']) {
      expect(bodyOf(screenSrc, SCREEN_FILE, fn)).not.toMatch(/Delivery|delivery|Linking|mail/i);
    }
  });
});

// ── The readiness card ──────────────────────────────────────────────────────

describe('the readiness card: the button, or core’s sentence', () => {
  it('the button is core’s label and spoken name, 44 pt, disabled offline (with the reason) or while anything runs', () => {
    expect(summary).toMatch(
      /\{shortfallPo && shortfallPo\.offer\.kind === 'button' \? \(\s*<Button\s+size="sm"\s+variant="outline"\s+disabled=\{offline \|\| checking \|\| shortfallPo\.disabled\}\s+onPress=\{shortfallPo\.onPress\}\s+accessibilityLabel=\{shortfallPo\.offer\.accessibilityLabel\}\s+accessibilityHint=\{offline \? READINESS_NEEDS_CONNECTION_COPY : SHORTFALL_PO_PHONE_STRIP_HINT\}\s+style=\{\{ alignSelf: 'flex-start', marginTop: 6, minHeight: MIN_TAP \}\}\s*>\s*\{shortfallPo\.offer\.label\}/,
    );
    expect(summary).toMatch(
      /: shortfallPo\?\.offer\.kind === 'needs_permission' \? \(\s*<Body size=\{12\.5\} muted>\s*\{shortfallPo\.offer\.message\}/,
    );
    expect(summary).not.toMatch(/\bbook\b|%/i);
  });
});

// ── The sheet ───────────────────────────────────────────────────────────────

describe('the draft sheet', () => {
  // OTA-safe (JS only) and nothing that sends or composes mail.
  it('imports only JS modules, and nothing that opens mail', () => {
    const imports = [...sheetSrc.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      [
        '@/components/item-verification-card',
        '@/components/ui/text',
        '@/lib/exception-sheet-layout',
        '@/lib/order-readiness',
        '@/lib/order-shortfall-po',
        '@/lib/orders-api',
        '@/lib/supabase',
        '@/lib/theme',
        '@/lib/use-sheet-keyboard-fields',
        '@/lib/use-theme',
        '@stockpilot/core',
        'lucide-react-native',
        'react',
        'react-native',
        'react-native-safe-area-context',
      ].sort(),
    );
    expect(sheetCode).not.toMatch(/Linking|openURL|MailComposer|mailto|openDeliveryRequestDraft/);
  });

  // Mutations caught: a hand-built POST, the key minted per press (a double
  // tap or a retry would draft twice), the key kept after a refusal that
  // stands for another request, the refusal only in an Alert (pattern #20),
  // the choices dropped after "Stock or POs changed", a second send while the
  // first is on its way.
  it('Draft: the tested submit with the request’s key, the refusal said in place and announced, the choices kept', () => {
    // Review: the refusal names what it unticked (adoptShortfallRefusal, the
    // web's words), and that is what is shown and announced.
    expect(bodyOf(sheetSrc, SHEET_FILE, 'draft')).toBe(
      "{ if (drafting.current || !sheet.canDraft) return; drafting.current = true; const lines = sheet.lines; keyRef.current = shortfallIdempotencyKey(keyRef.current, orderId, lines, mintShortfallKey); setBusy(true); setError(null); setNotice(null); const result = await submitShortfallPo({ draft: draftOrderShortfallPos, reread: (id) => readOrderReadiness(supabase, id) }, { orderId, lines, key: keyRef.current, shown: view }); drafting.current = false; setBusy(false); if (result.kind === 'created') { setCreated(result); AccessibilityInfo.announceForAccessibility(result.message); onDrafted(); return; } const next = adoptShortfallRefusal(selection, view, result); setError(next.message); AccessibilityInfo.announceForAccessibility(next.message); if (result.dropKey) keyRef.current = null; setView(next.view); setSelection(next.selection); if (result.closed) setClosed(true); if (result.refresh) onRefresh(); }",
    );
    expect(sheetCode).toContain('const keyRef = React.useRef<ShortfallKeyState | null>(null);');
    expect(sheetCode).toContain(
      'const [selection, setSelection] = React.useState<ShortfallSelection>(() => defaultShortfallSelection(startView));',
    );
    expect(sheetCode).toMatch(/<Body size=\{13\} color=\{ACCENT\.crit\} accessibilityRole="alert">\s*\{error\}/);
  });

  // Plan vitest: "The phone sheet is disabled offline". Mutation caught:
  // Draft enabled offline, or offline said nowhere.
  it('what it shows is the tested view; offline Draft is off and says why', () => {
    expect(sheetCode).toContain(
      'const sheet = shortfallSheetView({ view, selection, supplierNames, timeZone, offline, busy, closed });',
    );
    expect(sheetCode).toContain('const finished = done || closed || !sheet.offersDraft;');
    expect(sheetCode).toMatch(
      /\{finished \? null : \(\s*<Pressable\s+onPress=\{\(\) => void draft\(\)\}\s+disabled=\{!sheet\.canDraft\}\s+accessibilityRole="button"\s+accessibilityLabel=\{SHORTFALL_PO_SUBMIT_LABEL\}\s+accessibilityState=\{\{ disabled: !sheet\.canDraft, busy \}\}\s+accessibilityHint=\{sheet\.draftBlockedBy \?\? undefined\}/,
    );
    expect(sheetCode).toMatch(/\{offline && !finished \? \(\s*<Body size=\{12\.5\} muted>\s*\{READINESS_NEEDS_CONNECTION_COPY\}/);
    expect(bodyOf(sheetSrc, SHEET_FILE, 'requestClose')).toBe('{ if (busy) return; onClose(); }');
    // Review (identical on web and phone): any edit drops the key (an edit
    // changed back is a new request, as on the web) and clears the refusal.
    // Mutation caught: an edit that keeps the key.
    expect(bodyOf(sheetSrc, SHEET_FILE, 'edit')).toBe('{ setSelection(next); keyRef.current = null; setError(null); }');
  });

  it('every word is core’s or the tested phone words: title, rows, problems, footer, the result and the review sentence', () => {
    for (const shown of [
      '{SHORTFALL_PO_TITLE}',
      '{SHORTFALL_PO_SUBMIT_LABEL}',
      '{row.name}',
      '{row.sku}',
      '{row.detail}',
      '{row.supplier}',
      '{row.problem}',
      '{sheet.hiddenNote}',
      '{sheet.checkedAt}',
      '{sheet.footer}',
      '{sheet.unavailable}',
      '{notice}',
      '{created.message}',
      '{r.label}',
      '{r.supplier}',
      '{SHORTFALL_PO_PHONE_REVIEW_COPY}',
      '<FieldLabel>{SHORTFALL_PO_QUANTITY_LABEL}</FieldLabel>',
    ]) {
      expect(sheetCode).toContain(shown);
    }
    // No literal sentence of its own in what it renders (every word, the
    // spoken "Close" included, is core's).
    const sf = parseTsx(sheetSrc, SHEET_FILE);
    const literals: string[] = [];
    walkJsx(sf, (el) => {
      if (ts.isJsxElement(el)) {
        for (const ch of el.children) {
          if (ts.isJsxText(ch) && !ch.containsOnlyTriviaWhiteSpaces) literals.push(ch.getText(sf).trim());
        }
      }
    });
    expect(literals).toEqual([]);
    for (const src of [sheetCode, codeOnly(read(LIB_FILE))]) {
      expect(src).not.toMatch(/\bbook\b|%|verified|guarantee|was sent|emailed/i);
    }
  });

  it('the notice from opening is shown, and announced once (the web’s is a live region)', () => {
    expect(sheetCode).toContain('const [notice, setNotice] = React.useState<string | null>(startNotice);');
    expect(sheetCode).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(startNotice\) AccessibilityInfo\.announceForAccessibility\(startNotice\);\s*\}, \[startNotice\]\);/,
    );
    expect(sheetCode).toMatch(/\{notice && !error && !created \? \(\s*<Body size=\{13\} color=\{ACCENT\.warn\}>\s*\{notice\}/);
  });

  describe('structure (sibling backdrop, VoiceOver, 44 pt, Dynamic Type, the keyboard)', () => {
    const { sf, all, a } = tree(sheetSrc, SHEET_FILE);
    const container = all.find((n) => a(n.el, 'accessibilityViewIsModal') === 'true')!;
    const body = all.find((n) => tagOf(n.el, sf) === 'ScrollView')!;
    const [scrim, card, ...rest] = kidsOf(container.el);

    it('a KeyboardAvoidingView around a container that keeps VoiceOver inside and holds exactly [scrim, card]', () => {
      expect(tagOf(container.el, sf)).toBe('View');
      expect(a(container.el, 'onAccessibilityEscape')).toBe('requestClose');
      expect(a(container.el, 'onLayout')).toBe('(e) => setAvailableHeight(e.nativeEvent.layout.height)');
      const parent = container.ancestors.at(-1)!;
      expect(tagOf(parent, sf)).toBe('KeyboardAvoidingView');
      expect(a(parent, 'behavior')).toBe("Platform.OS === 'ios' ? 'padding' : undefined");
      expect(rest).toEqual([]);
      expect(tagOf(scrim!, sf)).toBe('Pressable');
      expect(hasContent(scrim!)).toBe(false);
      for (const prop of ['onPress', 'onAccessibilityTap']) expect(a(scrim!, prop)).toBe('requestClose');
      expect(a(scrim!, 'accessibilityRole')).toBe('button');
      expect(a(scrim!, 'accessibilityLabel')).toBe('SHORTFALL_PO_CLOSE_LABEL');
      expect(a(scrim!, 'style')).toContain('StyleSheet.absoluteFill');
      expect(tagOf(card!, sf)).toBe('View');
      expect(a(card!, 'onPress')).toBeUndefined();
      expect(a(card!, 'accessible')).toBeUndefined();
      // It claims a touch only while the keyboard is up, to put it away.
      expect(a(card!, 'onStartShouldSetResponder')).toBe('kb.claimTapOutside');
      expect(a(card!, 'onResponderRelease')).toBe('kb.onTapOutside');
    });

    it('the sheet is never taller than the space the keyboard leaves; the body gives way and scrolls through the hook', () => {
      expect(sheetCode).toMatch(
        /const layout = exceptionSheetLayout\(\{\s+windowHeight: height,\s+availableHeight,\s+topInset: insets\.top,?\s+\}\);/,
      );
      expect(a(card!, 'style')).toContain('maxHeight: layout.sheetMaxHeight');
      expect(sheetCode).toContain('const [attachBody, kb] = useSheetKeyboardFields();');
      expect(all.filter((n) => tagOf(n.el, sf) === 'ScrollView')).toHaveLength(1);
      const style = a(body.el, 'style') ?? '';
      expect(style).toContain('maxHeight: layout.bodyMaxHeight');
      expect(style).toContain('flexShrink: 1');
      expect((a(body.el, 'ref') ?? '').replace(/\s+/g, ' ')).toBe('(node) => { attachBody(node); bodyNode.current = node; }');
      expect(a(body.el, 'onScroll')).toBe('kb.onBodyScroll');
      expect(a(body.el, 'scrollEventThrottle')).toBe('16');
      expect(a(body.el, 'onLayout')).toBe('kb.onBodyLayout');
      expect(a(body.el, 'onContentSizeChange')).toBe('kb.onBodyContentSizeChange');
      expect(a(body.el, 'keyboardDismissMode')).toBe('on-drag');
      expect(a(body.el, 'keyboardShouldPersistTaps')).toBe('handled');
    });

    // Mutations caught: the field not reporting focus or where it sits, or its
    // row not directly in the body (the revealer would scroll to the wrong
    // place), keyed by anything but the item.
    it('each quantity is revealed above the keyboard: it reports focus, blur and where it sits in its row, its row directly in the body', () => {
      const inputs = all.filter((n) => tagOf(n.el, sf) === 'TextInput');
      expect(inputs).toHaveLength(1);
      const input = inputs[0]!;
      expect(a(input.el, 'onFocus')).toBe('() => kb.onFieldFocus(row.itemId)');
      expect(a(input.el, 'onBlur')).toBe('() => kb.onFieldBlur(row.itemId)');
      expect(a(input.el, 'onLayout')).toBe('(e) => kb.onFieldLayout(row.itemId, e)');
      const row = input.ancestors.at(-1)!;
      expect(tagOf(row, sf)).toBe('View');
      expect(a(row, 'onLayout')).toBe('(e) => kb.onRowLayout(row.itemId, e)');
      expect(input.ancestors.at(-2)).toBe(body.el);
    });

    it('the quantity is named for its item, stops growing at the input ceiling, and is off unless its row is chosen', () => {
      const input = all.find((n) => tagOf(n.el, sf) === 'TextInput')!;
      expect(a(input.el, 'accessibilityLabel')).toBe('row.quantityAccessibilityLabel');
      expect(a(input.el, 'accessibilityHint')).toBe('row.quantityAccessibilityHint');
      expect(a(input.el, 'maxFontSizeMultiplier')).toBe('INPUT_CAP');
      expect(a(input.el, 'editable')).toBe('row.checked && !locked');
      expect(a(input.el, 'keyboardType')).toBe('decimal-pad');
      expect(a(input.el, 'value')).toBe('row.quantity');
      expect(a(input.el, 'onChangeText')).toBe('(t) => edit(setShortfallQuantity(selection, view, row.itemId, t))');
      expect(input.ancestors.filter((x) => TOUCHABLE_TAG.test(tagOf(x, sf)))).toEqual([]);
      expect(sheetCode).toContain('const INPUT_CAP = capTo(15, TYPE_CEILING.input);');
      expect(sheetCode).toMatch(/input: \{\s*minHeight: MIN_TAP,/);
    });

    // Mutation caught: the row folded into one element with its field, or a
    // covered row that can still be chosen.
    it('each item’s checkbox is its own element, read in core’s words, never wrapping the field', () => {
      const boxes = all.filter((n) => a(n.el, 'accessibilityRole') === 'checkbox');
      expect(boxes).toHaveLength(1);
      const box = boxes[0]!;
      expect(tagOf(box.el, sf)).toBe('Pressable');
      expect(a(box.el, 'onPress')).toBe('() => edit(toggleShortfallChoice(selection, view, row.itemId))');
      expect(a(box.el, 'disabled')).toBe('!row.draftable || locked');
      expect(a(box.el, 'accessibilityLabel')).toBe('row.accessibilityLabel');
      expect(a(box.el, 'accessibilityState')).toBe('{ checked: row.checked, disabled: !row.draftable || locked }');
      expect(a(box.el, 'style')).toBe('styles.check');
      expect(sheetCode).toMatch(/check: \{[^}]*minHeight: MIN_TAP,/);
      const inside = all.filter((n) => n.ancestors.includes(box.el));
      expect(inside.some((n) => tagOf(n.el, sf) === 'TextInput')).toBe(false);
    });

    it('every button in the card is its own named 44 pt button, its label capped', () => {
      const presses = all.filter(
        (n) => tagOf(n.el, sf) === 'Pressable' && n.el !== scrim && a(n.el, 'accessibilityRole') !== 'checkbox',
      );
      expect(presses.length).toBe(4); // the X, a created draft's row, Draft, Cancel / Close
      for (const p of presses) {
        expect(a(p.el, 'accessibilityRole')).toBe('button');
        expect(a(p.el, 'accessibilityLabel')).toBeDefined();
        expect(p.ancestors.filter((x) => TOUCHABLE_TAG.test(tagOf(x, sf)))).toEqual([]);
        expect(p.ancestors.some((x) => a(x, 'accessible') !== undefined)).toBe(false);
        const style = a(p.el, 'style') ?? '';
        expect(style.includes('MIN_TAP') || style.includes('styles.action') || style.includes('styles.createdRow')).toBe(true);
      }
      expect(sheetCode).toMatch(/action: \{[^}]*minHeight: MIN_TAP,/);
      expect(sheetCode).toMatch(/createdRow: \{[^}]*minHeight: MIN_TAP,/);
      expect(sheetCode).toContain('const ACTION_CAP = capTo(13, TYPE_CEILING.control);');
      expect(count(sheetCode, 'maxFontSizeMultiplier={ACTION_CAP}')).toBe(2);
      const title = all.find((n) => a(n.el, 'accessibilityRole') === 'header');
      expect(title && a(title.el, 'maxFontSizeMultiplier')).toBe('TITLE_CAP');
      expect(sheetCode).toContain('const TITLE_CAP = capTo(16, TYPE_CEILING.display);');
    });

    it('a created draft’s row opens it on the PO screen, named with its supplier, and says it is reviewed and ordered on the web', () => {
      const created = all.find((n) => a(n.el, 'onPress') === '() => onOpenDraft(r.route)')!;
      expect(created).toBeDefined();
      expect(a(created.el, 'accessibilityLabel')).toBe('r.accessibilityLabel');
      expect(a(created.el, 'accessibilityHint')).toBe('SHORTFALL_PO_OPEN_DRAFT_HINT');
      expect(sheetCode).toContain('{shortfallCreatedRows(created.result, supplierNames).map((r) => (');
      const review = sheetCode.indexOf('{SHORTFALL_PO_PHONE_REVIEW_COPY}');
      expect(review).toBeGreaterThan(sheetCode.indexOf('onOpenDraft(r.route)'));
    });

    it('a refusal is the first thing in the body, which is scrolled to it', () => {
      const opening = ts.isJsxElement(body.el) ? body.el.openingElement.getEnd() : body.el.getEnd();
      const bodyText = codeOnly(sheetSrc.slice(opening, body.el.getEnd()));
      expect(bodyText.replace(/\{\s*\}/g, '').trim().startsWith('{error ? (')).toBe(true);
      expect(count(sheetCode, '{error}')).toBe(1);
      expect(sheetCode).toMatch(
        /React\.useEffect\(\(\) => \{\s*if \(error !== null\) bodyNode\.current\?\.scrollTo\(\{ y: 0, animated: true \}\);\s*\}, \[error\]\);/,
      );
      // The offline note stays beside Draft, outside the body.
      expect(sheetCode.indexOf('{READINESS_NEEDS_CONNECTION_COPY}')).toBeGreaterThan(sheetCode.indexOf('</ScrollView>'));
    });

    // Local walk 2026-09-30 (iPad, AX5): the body scrolled to the footer
    // before Draft kept that offset when the result replaced the rows, so the
    // sheet opened mid-sentence with "Created 2 draft POs:" hidden above.
    // Mutation caught: the result shown without bringing its start into view.
    it('the result is the first thing in the body, which is scrolled to it', () => {
      expect(sheetCode).toMatch(
        /React\.useEffect\(\(\) => \{\s*if \(created !== null\) bodyNode\.current\?\.scrollTo\(\{ y: 0, animated: true \}\);\s*\}, \[created\]\);/,
      );
      const opening = ts.isJsxElement(body.el) ? body.el.openingElement.getEnd() : body.el.getEnd();
      const bodyText = codeOnly(sheetSrc.slice(opening, body.el.getEnd()));
      // Only the refusal (cleared when Draft is pressed) and the opening
      // notice (hidden once drafted) come before it.
      const createdAt = bodyText.indexOf('{created ? (');
      expect(createdAt).toBeGreaterThan(-1);
      expect(bodyText.slice(0, createdAt)).toMatch(/\{notice && !error && !created \? \(/);
      expect(sheetCode).toMatch(/setBusy\(true\);\s*setError\(null\);/);
    });
  });
});

// ── The hook ────────────────────────────────────────────────────────────────

describe('the keyed sheet keyboard (lib/use-sheet-keyboard-fields.ts)', () => {
  const hook = codeOnly(read('src/lib/use-sheet-keyboard-fields.ts'));

  it('drives the keyed revealer, scrolls the body animated, and reports each measurement by field', () => {
    expect(hook).toContain('createFieldsRevealer((y) => body?.scrollTo({ y, animated: true }))');
    expect(hook).toContain('revealer.scrolled(e.nativeEvent.contentOffset.y)');
    expect(hook).toContain('revealer.viewportChanged(e.nativeEvent.layout.height)');
    expect(hook).toContain('revealer.contentChanged(h)');
    expect(hook).toContain('revealer.blockLaid(key, e.nativeEvent.layout.y, e.nativeEvent.layout.height)');
    expect(hook).toContain('revealer.fieldLaid(key, e.nativeEvent.layout.y, e.nativeEvent.layout.height)');
    expect(hook).toContain('onFieldFocus: (key: string) => revealer.focus(key)');
    expect(hook).toContain('onFieldBlur: (key: string) => revealer.blur(key)');
    expect(hook).toMatch(/Keyboard\.addListener\('keyboardDidShow', \(\) => revealer\.keyboardShown\(\)\)/);
    expect(hook).toContain('sub.remove()');
    expect(hook).toContain('claimTapOutside: () => Keyboard.isVisible()');
    expect(hook).toContain('onTapOutside: () => Keyboard.dismiss()');
    expect(hook).toContain('return [sheet.attachBody, handlers] as const;');
  });
});

// ── The PO screen: a draft is read-only ─────────────────────────────────────

describe('the PO screen opens a draft read-only', () => {
  it('only a draft is review-only, in core’s words (the sheet’s own sentence)', () => {
    expect(poIsReviewOnly('draft')).toBe(true);
    for (const s of ['ordered', 'expected_inbound', 'partially_received', 'received', 'cancelled', null, undefined, '']) {
      expect(poIsReviewOnly(s)).toBe(false);
    }
    expect(PO_DRAFT_REVIEW_COPY).toBe(SHORTFALL_PO_PHONE_REVIEW_COPY);
    expect(PO_DRAFT_REVIEW_COPY).toBe('Review and order this draft on the web.');
  });

  // Mutations caught: Post receipt, Scan or a quantity field offered on a
  // draft (the database refuses the receipt, 0349 po_not_ordered), or the
  // sentence missing.
  it('a draft shows no Scan, no quantities and no Post receipt, and says where it is ordered', () => {
    expect(po).toContain('const reviewOnly = poIsReviewOnly(header?.status);');
    expect(po).toMatch(/buildPoBlocks\(lines, reviewOnly \? \{\} : groups\)/);
    expect(po).toMatch(/\{reviewOnly \? null : \(\s*<Pressable\s+onPress=\{openScanner\}/);
    expect(po).toMatch(/\{reviewOnly \? null : remaining === 0 \? \(/);
    expect(po).toMatch(/\{reviewOnly \? null : \(\s*<View style=\{styles\.footer\}>/);
    expect(po).toMatch(/\{reviewOnly \? \(\s*<View style=\{styles\.partNotice\}>\s*<Text style=\{styles\.partNoticeText\}>\{PO_DRAFT_REVIEW_COPY\}<\/Text>/);
    expect(po).toContain("if (s === 'draft') return 'Draft';");
  });

  // Local walk 2026-09-30 (iPad and iPhone 17): the root stack shows no
  // header and this screen drew none of its own, so a draft opened from the
  // sheet's result rows (read-only, nothing to do there) could be left only
  // by the edge swipe. Every other card screen has the Back chip.
  // Mutations caught: no Back; Back only once the PO has loaded (loading and
  // "Could not load this PO" had no way out); a Back under 44 pt or unnamed;
  // no way home when the screen was opened with nothing to go back to.
  it('a Back chip, 44 pt and named, sits above every state of the screen', () => {
    expect(po).toContain("import { ArrowLeft } from 'lucide-react-native';");
    expect(po).toContain("import { IconChip } from '@/components/ui/row';");
    expect(count(po, '<IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />')).toBe(1);
    expect(po).toMatch(
      /const goBack = \(\) => \{\s*if \(router\.canGoBack\(\)\) router\.back\(\);\s*else router\.replace\('\/'\);\s*\};/,
    );
    const back = po.indexOf('<IconChip icon={ArrowLeft}');
    expect(back).toBeGreaterThan(po.indexOf('<Stack.Screen'));
    expect(back).toBeLessThan(po.indexOf('{loading ? ('));
  });
});
