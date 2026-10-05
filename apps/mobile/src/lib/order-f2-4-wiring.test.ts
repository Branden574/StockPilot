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
 * F2-4 CALL-SITE PINS: Outlook rule 1 on the phone. Changing an order's
 * needed-by generates no email, and the requester's "Email delivery request"
 * draft (which already carries the current needed-by) opens only when they
 * tap it: never on render, on a refresh, on focus or on an offline replay.
 * The order screen imports native modules, so vitest cannot render it; these
 * pins keep the one path from the composer to the OS a tap. (The web twin:
 * send-delivery-request-button.test.tsx, "does not mount the assistant until
 * opened".) Each names the mutation it catches.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCREEN_FILE = 'app/order/[id].tsx';

/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const screen = codeOnly(readFileSync(path.join(MOBILE_ROOT, SCREEN_FILE), 'utf8'));

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

/** The body of `function name(...) { ... }` in the screen. */
function functionBody(name: string): string {
  const at = screen.search(new RegExp(`function ${name}\\(`));
  expect(at, `function ${name} is in ${SCREEN_FILE}`).toBeGreaterThan(-1);
  return balanced(screen, screen.indexOf('{', screen.indexOf(')', at)));
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('the delivery-request draft opens only on a tap (Outlook rule 1)', () => {
  it('the OS opener is called in one place, runDeliveryOpen (mutation: a second call site)', () => {
    expect(count(screen, 'openDeliveryRequestDraft(')).toBe(1);
    expect(functionBody('runDeliveryOpen')).toContain('openDeliveryRequestDraft(');
  });

  it('runDeliveryOpen runs from the press handler and its "Open Another Draft" button only', () => {
    // Every call, not the declaration (`async function runDeliveryOpen()`).
    const calls = count(screen, 'runDeliveryOpen()') - count(screen, 'function runDeliveryOpen()');
    const press = functionBody('handleDeliveryRequestPress');
    expect(calls).toBe(2);
    expect(count(press, 'runDeliveryOpen()')).toBe(calls);
    expect(press).toMatch(/text: 'Open Another Draft', onPress: \(\) => void runDeliveryOpen\(\)/);
  });

  it('the press handler is wired to the "Email delivery request" button and nothing else', () => {
    expect(count(screen, 'handleDeliveryRequestPress')).toBe(2); // its declaration and the button
    expect(screen).toMatch(/actionBtn\('Email delivery request', 'delivery-request', handleDeliveryRequestPress\)/);
  });

  it('no effect, focus or refresh callback reaches the composer (mutation: open it from an effect)', () => {
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useCallback)\(/g;
    const bodies: string[] = [];
    for (let m = hooks.exec(screen); m; m = hooks.exec(screen)) {
      bodies.push(balanced(screen, m.index + m[0].length - 1));
    }
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).not.toMatch(/runDeliveryOpen|handleDeliveryRequestPress|openDeliveryRequestDraft/);
    }
  });
});

// ── The needed-by change on the phone (F2-4, UI step) ──────────────────────

const SHEET_FILE = 'src/components/revise-needed-by-sheet.tsx';
const CARD_FILE = 'src/components/order-needed-by-card.tsx';
// The day chips, slots, Other time and preview moved into the shared picker
// (phone ordering PO-4: the storefront's checkout uses the same one). Their
// pins moved with them, unchanged in substance.
const PICKER_FILE = 'src/components/needed-by-picker.tsx';
const sheetSrc = readFileSync(path.join(MOBILE_ROOT, SHEET_FILE), 'utf8');
const cardSrc = readFileSync(path.join(MOBILE_ROOT, CARD_FILE), 'utf8');
const pickerSrc = readFileSync(path.join(MOBILE_ROOT, PICKER_FILE), 'utf8');
const sheetCode = codeOnly(sheetSrc);
const cardCode = codeOnly(cardSrc);
const pickerCode = codeOnly(pickerSrc);

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

describe('the order screen: the needed-by card and Change', () => {
  // Mutation caught: Change for a non-approver, a closed order, or Orders off.
  it('Change is offered by the tested gate: orders:approve in the effective set, on an open order where Orders is on', () => {
    expect(screen).toMatch(
      /const canChangeNeededBy =\s*order !== null &&\s*canOfferNeededByChange\(\{\s*status: order\.status,\s*role,\s*canApproveOrders: rpApprove,\s*ordersModuleEnabled: enabledModules\.has\('orders'\),?\s*\}\);/,
    );
  });

  it("the card prints core's label in the org's zone, and Change opens the sheet on a tap only", () => {
    expect(screen).toMatch(
      /\{showNeededByCard\(order\.neededBy, canChangeNeededBy\) \? \(\s*<OrderNeededByCard\s+value=\{neededByCardValue\(order\.neededBy, order\.orgTimezone\)\}\s+canChange=\{canChangeNeededBy\}\s+busy=\{acting === 'needed-by'\}\s+disabled=\{acting !== null\}\s+offline=\{offline\}\s+onChange=\{\(\) => void openNeededBySheet\(\)\}\s*\/>\s*\) : null\}/,
    );
    // Declared once, called from the card's button once: no effect, focus or
    // refresh opens it (mutation: open the sheet from an effect).
    expect(count(screen, 'openNeededBySheet(')).toBe(2);
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useCallback|useMemo)\(/g;
    for (let m = hooks.exec(screen); m; m = hooks.exec(screen)) {
      expect(balanced(screen, m.index + m[0].length - 1)).not.toMatch(
        /openNeededBySheet|setNeededBySheet\(\{|ReviseNeededBySheet/,
      );
    }
  });

  // Mutations caught: the two reads made one after the other (serial), the
  // zone guessed instead of read, the warehouse check dropped, or the
  // needed-by re-formatted through a Date (it would drop the microseconds some
  // rows carry and every save would be refused as stale).
  it('opening reads the zone and warehouse access together, refuses in core words, and starts from the needed-by exactly as read', () => {
    expect(bodyOf(screen, SCREEN_FILE, 'openNeededBySheet')).toBe(
      "{ if (!order || !orgId || offline || acting !== null) return; setActing('needed-by'); try { const [rawZone, scope] = await Promise.all([ order.orgTimezone ?? readOrgTimeZone(supabase, orgId), readDestinationWarehouseScope(supabase, { role, organizationId: orgId, userId }) ]); const opening = neededBySheetOpening({ rawZone, scope, warehouseId: order.warehouseId }); if (!opening.ok) { Alert.alert(opening.title, opening.message); return; } setNeededBySheet({ orderId: order.id, orderLabel: order.orderNumber ? formatOrderNumber(order.orderNumber) : null, timeZone: opening.timeZone, startNeededBy: order.neededBy, orderStatus: order.status }); } finally { setActing(null); } }",
    );
  });

  // Outlook rule 1: a revision generates no email. Mutation caught: the
  // delivery draft opened (or its handler run) after a save.
  it('after a save: core’s confirmation, the order read again, and nothing else (no email, no draft)', () => {
    const saved = bodyOf(screen, SCREEN_FILE, 'handleNeededBySaved');
    expect(saved).toBe('{ setNeededBySheet(null); Alert.alert(title, message); await load(); }');
    expect(saved).not.toMatch(/Delivery|delivery|Linking|mail/i);
  });

  it('the sheet is mounted per open with what it opened on, knows when the phone is offline, and reloads behind itself', () => {
    expect(screen).toMatch(
      /\{neededBySheet && orgId \? \(\s*<ReviseNeededBySheet\s+visible\s+orderId=\{neededBySheet\.orderId\}\s+organizationId=\{orgId\}\s+orderLabel=\{neededBySheet\.orderLabel\}\s+timeZone=\{neededBySheet\.timeZone\}\s+startNeededBy=\{neededBySheet\.startNeededBy\}\s+orderStatus=\{order\?\.status \?\? neededBySheet\.orderStatus\}\s+offline=\{offline\}\s+onClose=\{\(\) => setNeededBySheet\(null\)\}\s+onSaved=\{\(_outcome, title, message\) => void handleNeededBySaved\(title, message\)\}\s+onRefresh=\{\(\) => void load\(\)\}\s*\/>\s*\) : null\}/,
    );
  });

  // The order page keeps its speed: the zone read for the card starts beside
  // the lines read and is awaited where the other zone reads land. Mutation
  // caught: awaiting it on its own (a new serial round trip), or reading it
  // for an order with no needed-by.
  it('load reads the zone for the card beside the lines read (no serial round trip), only when needed', () => {
    const loadStart = screen.indexOf('const load = React.useCallback(async () => {');
    const zoneAt = screen.indexOf('const neededByZoneRead =', loadStart);
    const linesAt = screen.indexOf(".from('order_request_lines')", loadStart);
    expect(loadStart).toBeGreaterThan(-1);
    expect(zoneAt).toBeGreaterThan(loadStart);
    expect(linesAt).toBeGreaterThan(zoneAt);
    expect(screen).toMatch(
      /const neededByZoneRead =\s*headerForReadiness &&\s*needsNeededByZoneRead\(\{\s*neededBy: \(headerForReadiness\.needed_by as string \| null\) \?\? null,\s*readinessReadsZone: readinessRead !== null,\s*deliveryReadsZone: needsDeliveryRequestData\(\{\s*status: \(headerForReadiness\.status as string \| null\) \?\? null,\s*fulfillmentType: \(headerForReadiness\.fulfillment_type as string \| null\) \?\? null,?\s*\}\),?\s*\}\)\s*\? readOrgTimeZone\(supabase, orgId\)\s*: null;/,
    );
    expect(count(screen, 'await neededByZoneRead')).toBe(1);
    expect(screen).toMatch(
      /orgTimezone =\s*orgTimezone \?\? readinessAnswer\?\.\[1\] \?\? \(neededByZoneRead \? await neededByZoneRead : null\);/,
    );
    // The delivery read's own gate is the same predicate the skip uses.
    expect(screen).toMatch(/const isLiveDelivery =\s*headerRow != null &&\s*needsDeliveryRequestData\(\{/);
  });
});

describe('the revise sheet', () => {
  // OTA-safe and Outlook rule 1: JS only, and nothing in it composes mail.
  it('imports no native date picker and nothing that opens mail', () => {
    const imports = [...sheetSrc.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      [
        '@/components/item-verification-card',
        '@/components/needed-by-picker',
        '@/components/ui/text',
        '@/lib/exception-sheet-layout',
        '@/lib/order-needed-by',
        '@/lib/orders-api',
        '@/lib/supabase',
        '@/lib/theme',
        '@/lib/use-sheet-keyboard',
        '@/lib/use-theme',
        '@stockpilot/core',
        'lucide-react-native',
        'react',
        'react-native',
        'react-native-safe-area-context',
      ].sort(),
    );
    const pickerImports = [...pickerSrc.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(pickerImports.sort()).toEqual(
      [
        '@/components/item-verification-card',
        '@/components/ui/text',
        '@/lib/order-needed-by',
        '@/lib/theme',
        '@/lib/use-theme',
        'react',
        'react-native',
      ].sort(),
    );
    for (const src of [sheetCode, cardCode, pickerCode]) {
      expect(src).not.toMatch(/Linking|openURL|MailComposer|mailto|openDeliveryRequestDraft|DateTimePicker/);
    }
  });

  // Mutations caught: a hand-built POST, the expected value re-formatted or
  // taken from the live order (a reload would move it under the person), the
  // refusal only in an Alert (pattern #20), or the adopted value dropped.
  it('Save: the tested submit, the value it started from, the refusal said in place and announced', () => {
    expect(sheetCode).toContain(
      'const [expected, setExpected] = React.useState<string | null>(startNeededBy);',
    );
    expect(sheetCode).toMatch(
      /React\.useState<NeededByDraft>\(\(\) =>\s*initialNeededByDraft\(startNeededBy, Date\.now\(\), timeZone\),?\s*\)/,
    );
    expect(bodyOf(sheetSrc, SHEET_FILE, 'save')).toBe(
      "{ if (saving.current) return; const atTap = neededByDraftView(draft, { ...viewContext, now: readClock() }); if (!atTap.canSave || atTap.wall === null || atTap.reason === null) { setNow(readClock()); return; } saving.current = true; setBusy(true); setError(null); const result = await submitNeededByRevision({ revise: reviseOrderNeededBy, readCurrent: () => readOrderNeededBy(supabase, organizationId, orderId) }, { orderId, wall: atTap.wall, expected, reason: atTap.reason, zone: timeZone }); saving.current = false; setBusy(false); if (result.kind === 'saved') { onSaved(result.outcome, result.title, result.message); return; } setError(result.message); AccessibilityInfo.announceForAccessibility(result.message); if (result.current !== undefined) setExpected(result.current.neededBy); if (result.closed) setClosed(true); if (result.current !== undefined || result.closed) onRefresh(); }",
    );
    expect(sheetCode).toMatch(/<Body size=\{13\} color=\{ACCENT\.crit\} accessibilityRole="alert">\s*\{error\}/);
  });

  // Mutation caught: the preview (or its problem) changes and VoiceOver is
  // never told (the web's is a live region).
  it('a change of the chosen time is announced: the tested spoken update, debounced, never the opening state', () => {
    expect(sheetCode).toContain('const spoken = neededBySpokenUpdate(view);');
    expect(sheetCode).toContain('const lastSpoken = React.useRef(spoken);');
    expect(sheetCode).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(spoken === null \|\| spoken === lastSpoken\.current\) return;\s*const timer = setTimeout\(\(\) => \{\s*lastSpoken\.current = spoken;\s*AccessibilityInfo\.announceForAccessibility\(spoken\);\s*\}, SPOKEN_DEBOUNCE_MS\);\s*return \(\) => clearTimeout\(timer\);\s*\}, \[spoken\]\);/,
    );
  });

  it('what it shows is the tested view: core’s zone note, preview and current value; offline Save is off and says why', () => {
    expect(sheetCode).toMatch(
      /const viewContext = \{\s*zone: timeZone,\s*current: expected,\s*status: orderStatus,\s*offline,\s*busy,\s*closed,?\s*\};/,
    );
    expect(sheetCode).toContain('const view = neededByDraftView(draft, { ...viewContext, now });');
    // The clock ticks while the sheet is open, and every change reads it.
    expect(sheetCode).toContain('const [now, setNow] = React.useState(() => Date.now());');
    expect(sheetCode).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 30_000\);\s*return \(\) => clearInterval\(timer\);/);
    expect(bodyOf(sheetSrc, SHEET_FILE, 'readClock')).toBe('{ return Date.now(); }');
    expect(bodyOf(sheetSrc, SHEET_FILE, 'update')).toBe(
      '{ setDraft((d) => ({ ...d, ...patch })); setError(null); setNow(readClock()); }',
    );
    for (const shown of ['{view.current}', '{view.zoneNote}', '{view.reasonProblem}', '{view.effect}']) {
      expect(sheetCode).toContain(shown);
    }
    for (const shown of ['{view.preview}', '{view.timeProblem}', '{view.noSlotsNote}']) {
      expect(pickerCode).toContain(shown);
    }
    // The sheet hands the picker its own view and draft, and every pick goes
    // through the sheet's own update (which clears a refusal and re-reads the
    // clock), exactly as the chips did when they lived here.
    expect(sheetCode).toMatch(
      /<NeededByPicker\s+view=\{view\}\s+draft=\{draft\}\s+busy=\{busy\}\s+focusOther=\{focusOther\}\s+onPickDay=\{pickDay\}\s+onPickSlot=\{\(time\) => update\(\{ slot: time, other: false \}\)\}\s+onPickOther=\{\(\) => \{\s*update\(\{ other: true \}\);\s*setFocusOther\(true\);\s*\}\}\s+onOtherText=\{\(t\) => update\(\{ otherText: t \}\)\}\s*\/>/,
    );
    expect(count(sheetCode, '<NeededByPicker')).toBe(1);
    // The web dialog's words, from core: title, field, reason and its hint, Save.
    for (const word of [
      '{NEEDED_BY_REVISE_TITLE}',
      '<FieldLabel>{NEEDED_BY_FIELD_LABEL}</FieldLabel>',
      '<FieldLabel>{NEEDED_BY_REASON_LABEL}</FieldLabel>',
      '{NEEDED_BY_REASON_HINT}',
      '{NEEDED_BY_SAVE_LABEL}',
    ]) {
      expect(sheetCode).toContain(word);
    }
    expect(sheetSrc).toMatch(
      /import \{\s*NEEDED_BY_FIELD_LABEL,\s*NEEDED_BY_REASON_HINT,\s*NEEDED_BY_REASON_LABEL,\s*NEEDED_BY_REASON_MAX,\s*NEEDED_BY_REVISE_TITLE,\s*NEEDED_BY_SAVE_LABEL,/,
    );
    expect(sheetCode).toMatch(
      /<Pressable\s+onPress=\{\(\) => void save\(\)\}\s+disabled=\{!view\.canSave\}\s+accessibilityRole="button"\s+accessibilityLabel=\{NEEDED_BY_SAVE_LABEL\}\s+accessibilityState=\{\{ disabled: !view\.canSave, busy \}\}\s+accessibilityHint=\{view\.saveBlockedBy \?\? undefined\}/,
    );
    expect(sheetCode).toMatch(/\{offline && !closed \? \(\s*<Body size=\{12\.5\} muted>\s*\{READINESS_NEEDS_CONNECTION_COPY\}/);
    expect(bodyOf(sheetSrc, SHEET_FILE, 'requestClose')).toBe('{ if (busy) return; onClose(); }');
  });

  it('the chips are the tested days and slots, each a named 44 pt button with its selected state', () => {
    expect(pickerCode).toMatch(
      /\{view\.days\.map\(\(d\) =>\s*chip\(\s*d\.key,\s*view\.selectedDayKey === d\.key,\s*\(\) => onPickDay\(d\.key\),\s*d\.accessibilityLabel,\s*\[d\.label, d\.dateLabel\],\s*\(e\) => dayRow\.chipLaid\(d\.key, e\),?\s*\),?\s*\)\}/,
    );
    expect(pickerCode).toMatch(
      /\{view\.slots\.map\(\(s\) =>\s*chip\(\s*s\.time,\s*!draft\.other && draft\.slot === s\.time,\s*\(\) => onPickSlot\(s\.time\),\s*s\.label,\s*\[s\.label\],?\s*\),?\s*\)\}/,
    );
    expect(pickerCode).toMatch(
      /<Pressable\s+key=\{key\}\s+onPress=\{onPress\}\s+disabled=\{busy\}\s+accessibilityRole="button"\s+accessibilityLabel=\{accessibilityLabel\}\s+accessibilityState=\{\{ selected, disabled: busy \}\}\s+style=\{\[\s*styles\.chip,/,
    );
    expect(pickerCode).toMatch(/chip: \{\s*minHeight: MIN_TAP,\s*minWidth: MIN_TAP,/);
    expect(bodyOf(sheetSrc, SHEET_FILE, 'pickDay')).toBe(
      '{ const at = readClock(); setDraft((d) => selectNeededByDay(d, dayKey, at, timeZone)); setError(null); setNow(at); }',
    );
    expect(pickerCode).toContain('maxFontSizeMultiplier={CHIP_CAP}');
    expect(pickerCode).toContain('const CHIP_CAP = capTo(12.5, TYPE_CEILING.control);');
    // Other time: the chip, then focus only once chosen.
    expect(pickerCode).toMatch(/chip\(\s*'other',\s*draft\.other,\s*onPickOther,\s*NEEDED_BY_OTHER_TIME_LABEL,\s*\[NEEDED_BY_OTHER_TIME_LABEL\],?\s*\)/);
  });

  describe('structure (sibling backdrop, VoiceOver, 44 pt, Dynamic Type)', () => {
    const sf = parseTsx(sheetSrc, SHEET_FILE);
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

    it('a KeyboardAvoidingView around a container that keeps VoiceOver inside and holds exactly [scrim, card]', () => {
      expect(container).toBeDefined();
      expect(tagOf(container.el, sf)).toBe('View');
      expect(attrText(container.el, 'onAccessibilityEscape', sf)).toBe('requestClose');
      const parent = container.ancestors[container.ancestors.length - 1]!;
      expect(tagOf(parent, sf)).toBe('KeyboardAvoidingView');
      expect(attrText(parent, 'behavior', sf)).toBe("Platform.OS === 'ios' ? 'padding' : undefined");
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
      for (const prop of ['onPress', 'accessible']) {
        expect(attrText(card!, prop, sf)).toBeUndefined();
      }
      // It claims a touch only while the keyboard is up, to put it away (the
      // exception sheets' rule, lib/use-sheet-keyboard.ts).
      expect(attrText(card!, 'onStartShouldSetResponder', sf)).toBe('kb.claimTapOutside');
      expect(attrText(card!, 'onResponderRelease', sf)).toBe('kb.onTapOutside');
    });

    it('every button in the card (and the picker\'s chip) is its own named button of at least 44 pt, its label capped', () => {
      const presses = all.filter((n) => tagOf(n.el, sf) === 'Pressable' && n.el !== kids(container.el)[0]);
      expect(presses.length).toBe(3); // the X, Save, Cancel (the chips are the picker's, below)
      for (const p of presses) {
        expect(attrText(p.el, 'accessibilityRole', sf)).toBe('button');
        expect(attrText(p.el, 'accessibilityLabel', sf)).toBeDefined();
        expect(p.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
        expect(p.ancestors.some((a) => attrText(a, 'accessible', sf) !== undefined)).toBe(false);
        const style = attrText(p.el, 'style', sf) ?? '';
        expect(
          style.includes('MIN_TAP') || style.includes('styles.action') || style.includes('styles.chip'),
        ).toBe(true);
      }
      expect(sheetCode).toMatch(/action: \{[^}]*minHeight: MIN_TAP,/);
      expect(sheetCode).toContain('const ACTION_CAP = capTo(13, TYPE_CEILING.control);');
      expect(count(sheetCode, 'maxFontSizeMultiplier={ACTION_CAP}')).toBe(2);
    });

    it('both fields are named, stop growing at the input ceiling, lock while saving, and sit in no touchable', () => {
      const pickerSf = parseTsx(pickerSrc, PICKER_FILE);
      const pickerInputs: { el: JsxNode; ancestors: JsxNode[] }[] = [];
      walkJsx(pickerSf, (el, ancestors) => {
        if (tagOf(el, pickerSf) === 'TextInput') pickerInputs.push({ el, ancestors: [...ancestors] });
      });
      const inputs = all.filter((n) => tagOf(n.el, sf) === 'TextInput');
      expect(inputs).toHaveLength(1); // the reason (Other time is the picker's)
      expect(pickerInputs).toHaveLength(1);
      for (const [i, file] of [...inputs.map((n) => [n, sf] as const), ...pickerInputs.map((n) => [n, pickerSf] as const)]) {
        expect(attrText(i.el, 'accessibilityLabel', file)).toBeDefined();
        expect(attrText(i.el, 'maxFontSizeMultiplier', file)).toBe('INPUT_CAP');
        expect(attrText(i.el, 'editable', file)).toBe('!busy');
        expect(i.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, file)))).toEqual([]);
      }
      expect(sheetCode).toContain('const INPUT_CAP = capTo(15, TYPE_CEILING.input);');
      expect(pickerCode).toContain('const INPUT_CAP = capTo(15, TYPE_CEILING.input);');
      // The reason is capped at the function's limit (core's constant).
      expect(sheetCode).toContain('maxLength={NEEDED_BY_REASON_MAX}');
      // Other time takes focus only when the person chose it, never on open.
      expect(pickerCode).toContain('autoFocus={focusOther}');
      expect(sheetCode).toContain('focusOther={focusOther}');
    });

    it('the picker\'s chips are each their own named button of at least 44 pt, in no other touchable', () => {
      const pickerSf = parseTsx(pickerSrc, PICKER_FILE);
      const presses: { el: JsxNode; ancestors: JsxNode[] }[] = [];
      walkJsx(pickerSf, (el, ancestors) => {
        if (tagOf(el, pickerSf) === 'Pressable') presses.push({ el, ancestors: [...ancestors] });
      });
      expect(presses).toHaveLength(1); // the one chip builder
      const p = presses[0]!;
      expect(attrText(p.el, 'accessibilityRole', pickerSf)).toBe('button');
      expect(attrText(p.el, 'accessibilityLabel', pickerSf)).toBe('accessibilityLabel');
      expect(p.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, pickerSf)))).toEqual([]);
      expect(attrText(p.el, 'style', pickerSf) ?? '').toContain('styles.chip');
    });

    // iPhone 17 walk, 2026-09-30: at the default text size with the keyboard
    // up, and at AX5 with it down, the sheet ran off the TOP of the screen
    // (the title, Close, the current date and the day row under the status
    // bar): a fixed 50% body with the title and two buttons outside it. Now it
    // sizes itself like the exception sheets (lib/exception-sheet-layout.ts,
    // lib/use-sheet-keyboard.ts). Mutations caught: a fixed body height, the
    // body not giving way, the sheet not capped by the measured space, the
    // title uncapped, the reason not revealed above the keyboard.
    const body = all.find((n) => tagOf(n.el, sf) === 'ScrollView' && attrText(n.el, 'horizontal', sf) === undefined)!;
    const pickerSf = parseTsx(pickerSrc, PICKER_FILE);
    const pickerNodes: { el: JsxNode; ancestors: JsxNode[] }[] = [];
    walkJsx(pickerSf, (el, ancestors) => pickerNodes.push({ el, ancestors: [...ancestors] }));
    const dayRow = pickerNodes.find((n) => tagOf(n.el, pickerSf) === 'ScrollView' && attrText(n.el, 'horizontal', pickerSf) !== undefined)!;
    const a = (el: JsxNode, name: string) => attrText(el, name, sf);
    const pa = (el: JsxNode, name: string) => attrText(el, name, pickerSf);

    it('the sheet is never taller than the space the keyboard leaves, below the status bar', () => {
      expect(sheetCode).toContain('const { height } = useWindowDimensions();');
      expect(sheetCode).toContain('const insets = useSafeAreaInsets();');
      expect(sheetCode).toMatch(
        /const layout = exceptionSheetLayout\(\{\s+windowHeight: height,\s+availableHeight,\s+topInset: insets\.top,?\s+\}\);/,
      );
      expect(a(container.el, 'onLayout')).toBe('(e) => setAvailableHeight(e.nativeEvent.layout.height)');
      const card = kids(container.el)[1]!;
      expect(a(card, 'style')).toContain('maxHeight: layout.sheetMaxHeight');
      expect(sheetCode).not.toMatch(/height \* 0\.5|bodyMaxHeight = /);
    });

    it('the body is the part that gives way: capped by the measured space, shrinking first, scrolling through the keyboard hook', () => {
      expect(sheetCode).toContain('const [attachBody, kb] = useSheetKeyboard();');
      const style = a(body.el, 'style') ?? '';
      expect(style).toContain('maxHeight: layout.bodyMaxHeight');
      expect(style).toContain('flexShrink: 1');
      expect((a(body.el, 'ref') ?? '').replace(/\s+/g, ' ')).toBe('(node) => { attachBody(node); bodyNode.current = node; }');
      expect(a(body.el, 'onScroll')).toBe('kb.onBodyScroll');
      expect(a(body.el, 'scrollEventThrottle')).toBe('16');
      expect(a(body.el, 'onLayout')).toBe('kb.onBodyLayout');
      expect(a(body.el, 'onContentSizeChange')).toBe('kb.onBodyContentSizeChange');
      // A drag on the body puts the keyboard away; a tap on a chip or Save
      // still lands the first time.
      expect(a(body.el, 'keyboardDismissMode')).toBe('on-drag');
      expect(a(body.el, 'keyboardShouldPersistTaps')).toBe('handled');
      expect(pa(dayRow.el, 'keyboardShouldPersistTaps')).toBe('handled');
      // The picker sits directly in the body, so it scrolls with it.
      const picker = all.find((n) => tagOf(n.el, sf) === 'NeededByPicker')!;
      expect(picker.ancestors.at(-1)).toBe(body.el);
    });

    it('the reason (the low field) is revealed above the keyboard: it reports focus, blur and where it sits, its block directly in the body', () => {
      const reason = all.find((n) => tagOf(n.el, sf) === 'TextInput' && a(n.el, 'accessibilityLabel') === 'NEEDED_BY_REASON_LABEL')!;
      expect(reason).toBeDefined();
      expect(a(reason.el, 'onFocus')).toBe('kb.onNoteFocus');
      expect(a(reason.el, 'onBlur')).toBe('kb.onNoteBlur');
      expect(a(reason.el, 'onLayout')).toBe('kb.onNoteLayout');
      const block = reason.ancestors.at(-1)!;
      expect(tagOf(block, sf)).toBe('View');
      expect(a(block, 'onLayout')).toBe('kb.onNoteBlockLayout');
      expect(reason.ancestors.at(-2)).toBe(body.el);
    });

    // iPhone 17 walk at AX5, 2026-09-30: core's longest refusal (the
    // no-answer sentence, 557 pt tall) outside the body pushed the offline
    // note, Save and Cancel off the bottom of the screen. The refusal is now
    // the first thing in the body (it scrolls with it) and the body is
    // scrolled to it when it appears; the short offline note stays beside
    // Save. Mutations caught: the refusal back outside the body, or not
    // scrolled into view.
    it('a refusal is the first thing in the body, which is scrolled to it; the offline note stays beside Save', () => {
      const alert = all.find((n) => tagOf(n.el, sf) === 'Body' && /^"?alert"?$/.test(a(n.el, 'accessibilityRole') ?? ''))!;
      expect(alert).toBeDefined();
      expect(alert.ancestors).toContain(body.el);
      // Before everything else in the body (the current date comes next).
      const opening = ts.isJsxElement(body.el) ? body.el.openingElement.getEnd() : body.el.getEnd();
      const bodyText = codeOnly(sheetSrc.slice(opening, body.el.getEnd()));
      // (A JSX comment leaves an empty {} once its comment is stripped.)
      const firstChild = bodyText.replace(/\{\s*\}/g, '').trim();
      expect(firstChild.startsWith('{error ? (')).toBe(true);
      expect(bodyText.indexOf('{error}')).toBeLessThan(bodyText.indexOf('{view.current}'));
      expect(count(sheetCode, '{error}')).toBe(1);
      expect(sheetCode).toContain('const bodyNode = React.useRef<ScrollView | null>(null);');
      expect(sheetCode).toMatch(
        /React\.useEffect\(\(\) => \{\s*if \(error !== null\) bodyNode\.current\?\.scrollTo\(\{ y: 0, animated: true \}\);\s*\}, \[error\]\);/,
      );
      const offlineAt = sheetCode.indexOf('{READINESS_NEEDS_CONNECTION_COPY}');
      const bodyEnd = sheetCode.indexOf('</ScrollView>', sheetCode.indexOf('{view.effect}'));
      expect(offlineAt).toBeGreaterThan(bodyEnd);
    });

    it('the title stops growing at the display ceiling', () => {
      const title = all.find((n) => a(n.el, 'accessibilityRole') === '"header"' || a(n.el, 'accessibilityRole') === 'header');
      expect(title && a(title.el, 'maxFontSizeMultiplier')).toBe('TITLE_CAP');
      expect(sheetCode).toContain('const TITLE_CAP = capTo(16, TYPE_CEILING.display);');
    });

    // Mutation caught: the selected day left off the edge of the row on open.
    it('the selected day chip is scrolled into the row: on open (its layout, the row\'s) and when the selection moves', () => {
      expect(pa(dayRow.el, 'ref')).toBe('attachDayRow');
      expect(pa(dayRow.el, 'onLayout')).toBe('dayRow.rowLaid');
      expect(pa(dayRow.el, 'onScroll')).toBe('dayRow.scrolled');
      expect(pa(dayRow.el, 'scrollEventThrottle')).toBe('16');
      expect(pickerCode).toContain('const [attachDayRow, dayRow] = useDayRowReveal(view.selectedDayKey);');
      expect(pickerCode).toMatch(
        /\{view\.days\.map\(\(d\) =>\s*chip\(\s*d\.key,\s*view\.selectedDayKey === d\.key,\s*\(\) => onPickDay\(d\.key\),\s*d\.accessibilityLabel,\s*\[d\.label, d\.dateLabel\],\s*\(e\) => dayRow\.chipLaid\(d\.key, e\),?\s*\),?\s*\)\}/,
      );
      expect(pickerCode).toMatch(/style=\{\[\s*styles\.chip,[\s\S]*?\]\}\s+onLayout=\{onLayout\}/);
      expect(bodyOf(pickerSrc, PICKER_FILE, 'revealDay')).toBe(
        '{ if (!row || !key) return; const chip = geometry.chips.get(key); if (!chip) return; const x = neededByDayRowScroll({ chipX: chip.x, chipWidth: chip.w, offset: geometry.offset, viewport: geometry.width }); if (x === null) return; geometry.offset = x; row.scrollTo({ x, animated: false }); }',
      );
      const hook = bodyOf(pickerSrc, PICKER_FILE, 'useDayRowReveal');
      // Revealed when the selected chip lays out, when the row does, and when the selection moves.
      expect(hook).toContain('chipLaid: (key: string, e: LayoutChangeEvent) => { geometry.chips.set(key, { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width }); if (key === selected) revealDay(row, geometry, key); }');
      expect(hook).toContain('rowLaid: (e: LayoutChangeEvent) => { geometry.width = e.nativeEvent.layout.width; revealDay(row, geometry, selected); }');
      expect(hook).toContain('scrolled: (e: NativeSyntheticEvent<NativeScrollEvent>) => { geometry.offset = e.nativeEvent.contentOffset.x; }');
      expect(hook).toContain('select: (key: string | null) => { selected = key; revealDay(row, geometry, key); }');
      expect(hook).toContain('React.useEffect(() => { reveal.select(selectedDayKey); }, [reveal, selectedDayKey]);');
    });
  });
});

describe('the needed-by card', () => {
  it("core's row and Change (the web page's words); Change is its own named 44 pt button, off offline with the reason", () => {
    expect(cardCode).toMatch(/<Body size=\{15\} color=\{c\.ink\} style=\{stack \? undefined : \{ flex: 1 \}\}>\s*\{value\}/);
    expect(cardCode).toMatch(
      /<Pressable\s+onPress=\{onChange\}\s+disabled=\{off\}\s+accessibilityRole="button"\s+accessibilityLabel=\{NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL\}\s+accessibilityState=\{\{ disabled: off, busy \}\}\s+accessibilityHint=\{offline \? READINESS_NEEDS_CONNECTION_COPY : undefined\}/,
    );
    expect(cardCode).toMatch(/maxFontSizeMultiplier=\{BUTTON_CAP\}>\s*\{NEEDED_BY_CHANGE_LABEL\}/);
    expect(cardSrc).toMatch(/import \{\s*NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL,\s*NEEDED_BY_CHANGE_LABEL,\s*READINESS_NEEDS_CONNECTION_COPY,\s*\} from '@stockpilot\/core';/);
    expect(cardCode).toContain('const off = disabled || offline || busy;');
    expect(cardCode).toMatch(/button: \{\s*minHeight: MIN_TAP,\s*minWidth: MIN_TAP,/);
    expect(cardCode).toContain('maxFontSizeMultiplier={BUTTON_CAP}');
    expect(cardCode).toContain('const BUTTON_CAP = capTo(13, TYPE_CEILING.control);');
    // The button sits beside the date view, never inside it.
    const sf = parseTsx(cardSrc, CARD_FILE);
    walkJsx(sf, (el, ancestors) => {
      if (tagOf(el, sf) === 'Pressable') {
        expect(ancestors.some((a) => attrText(a, 'accessible', sf) !== undefined)).toBe(false);
      }
    });
  });
});
