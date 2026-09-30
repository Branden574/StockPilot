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
const sheetSrc = readFileSync(path.join(MOBILE_ROOT, SHEET_FILE), 'utf8');
const cardSrc = readFileSync(path.join(MOBILE_ROOT, CARD_FILE), 'utf8');
const sheetCode = codeOnly(sheetSrc);
const cardCode = codeOnly(cardSrc);

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
  it('Change is offered by the tested gate: approvers (or a manager by role) on an open order where Orders is on', () => {
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
        '@/components/ui/text',
        '@/lib/order-needed-by',
        '@/lib/orders-api',
        '@/lib/supabase',
        '@/lib/theme',
        '@/lib/use-theme',
        '@stockpilot/core',
        'lucide-react-native',
        'react',
        'react-native',
      ].sort(),
    );
    for (const src of [sheetCode, cardCode]) {
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
    for (const shown of [
      '{view.current}',
      '{view.zoneNote}',
      '{view.preview}',
      '{view.timeProblem}',
      '{view.noSlotsNote}',
      '{view.reasonProblem}',
      '{view.effect}',
    ]) {
      expect(sheetCode).toContain(shown);
    }
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
    expect(sheetCode).toMatch(
      /\{view\.days\.map\(\(d\) =>\s*chip\(\s*d\.key,\s*view\.selectedDayKey === d\.key,\s*\(\) => pickDay\(d\.key\),\s*d\.accessibilityLabel,\s*\[d\.label, d\.dateLabel\],?\s*\),?\s*\)\}/,
    );
    expect(sheetCode).toMatch(
      /\{view\.slots\.map\(\(s\) =>\s*chip\(\s*s\.time,\s*!draft\.other && draft\.slot === s\.time,\s*\(\) => update\(\{ slot: s\.time, other: false \}\),\s*s\.label,\s*\[s\.label\],?\s*\),?\s*\)\}/,
    );
    expect(sheetCode).toMatch(
      /<Pressable\s+key=\{key\}\s+onPress=\{onPress\}\s+disabled=\{busy\}\s+accessibilityRole="button"\s+accessibilityLabel=\{accessibilityLabel\}\s+accessibilityState=\{\{ selected, disabled: busy \}\}\s+style=\{\[\s*styles\.chip,/,
    );
    expect(sheetCode).toMatch(/chip: \{\s*minHeight: MIN_TAP,\s*minWidth: MIN_TAP,/);
    expect(bodyOf(sheetSrc, SHEET_FILE, 'pickDay')).toBe(
      '{ const at = readClock(); setDraft((d) => selectNeededByDay(d, dayKey, at, timeZone)); setError(null); setNow(at); }',
    );
    expect(sheetCode).toContain('maxFontSizeMultiplier={CHIP_CAP}');
    expect(sheetCode).toContain('const CHIP_CAP = capTo(12.5, TYPE_CEILING.control);');
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
      for (const prop of ['onPress', 'accessible', 'onStartShouldSetResponder']) {
        expect(attrText(card!, prop, sf)).toBeUndefined();
      }
    });

    it('every button in the card (and the chip) is its own named button of at least 44 pt, its label capped', () => {
      const presses = all.filter((n) => tagOf(n.el, sf) === 'Pressable' && n.el !== kids(container.el)[0]);
      expect(presses.length).toBe(4); // the chip, the X, Save, Cancel
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
      const inputs = all.filter((n) => tagOf(n.el, sf) === 'TextInput');
      expect(inputs).toHaveLength(2);
      for (const i of inputs) {
        expect(attrText(i.el, 'accessibilityLabel', sf)).toBeDefined();
        expect(attrText(i.el, 'maxFontSizeMultiplier', sf)).toBe('INPUT_CAP');
        expect(attrText(i.el, 'editable', sf)).toBe('!busy');
        expect(i.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
      }
      expect(sheetCode).toContain('const INPUT_CAP = capTo(15, TYPE_CEILING.input);');
      // The reason is capped at the function's limit (core's constant).
      expect(sheetCode).toContain('maxLength={NEEDED_BY_REASON_MAX}');
      // Other time takes focus only when the person chose it, never on open.
      expect(sheetCode).toContain('autoFocus={focusOther}');
    });

    it('the body scrolls with the keyboard up, and taps reach a chip or Save the first time', () => {
      expect(sheetCode).toMatch(
        /<ScrollView\s+style=\{\{ maxHeight: bodyMaxHeight \}\}\s+keyboardShouldPersistTaps="handled"/,
      );
      expect(sheetCode).toMatch(/<ScrollView\s+horizontal\s+showsHorizontalScrollIndicator=\{false\}\s+keyboardShouldPersistTaps="handled"/);
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
