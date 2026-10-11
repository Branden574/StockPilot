import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { TOUCHABLE_TAG, attrText, parseTsx, readSource, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * WIRING PINS for the requester's "Return or exchange" on the phone and the
 * iPad (returns RX-3). The mobile suite has no React Native renderer, so the
 * files are read and the element trees parsed, and what a screen could
 * otherwise lose silently is pinned:
 *
 *   - ONLINE ONLY: Send and the sizes follow the live connection, offline
 *     Send says "Needs a connection.", and nothing is ever queued;
 *   - the key: minted only through the remembered draft (openRequesterDraft),
 *     forgotten once the server answered, renewed after a conflict;
 *   - the sizes are asked for once, with no input, on the first Exchange;
 *   - VoiceOver: radio buttons with their state, named steppers, a labelled
 *     Close on the scrim, every field and the Send button their own element,
 *     a refusal announced;
 *   - Dynamic Type: rows stack past the AX threshold, item names are never
 *     capped or cut, only chrome is capped; the sheet is bounded by the
 *     space the keyboard leaves and each note's block sits directly in the
 *     body so the keyboard can reveal it;
 *   - the iPad: RETURNING and REPLACEMENT side by side where there is room;
 *   - the order screen: the gate, the read with every order read, the button
 *     through actionBtn (offline disabled), the requester's own requests.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SHEET_FILE = 'src/components/requester-return-sheet.tsx';
const sheet = code(read(SHEET_FILE));
const screen = code(read('app/order/[id].tsx'));

function treeOf(file: string, fnName: string) {
  const sf = parseTsx(readSource(path.join(ROOT, file)), file);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fnName,
  );
  if (!fn) throw new Error(`${file}: function ${fnName} not found`);
  const nodes: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(fn, (el, ancestors) => nodes.push({ el, ancestors: [...ancestors] }));
  return { sf, fn, nodes };
}

describe('the sheet: online only, and never queued', () => {
  it('Send follows the live connection and says why it is off', () => {
    expect(sheet).toContain('const canSend = online && !sending && !!draft && !!sheet && sheet.lines.length > 0 && !sizesLoading;');
    expect(sheet).toContain('const disabledReason = !online ? READINESS_NEEDS_CONNECTION_COPY : null;');
    expect(sheet).toMatch(/<Button\s+block\s+disabled=\{!canSend\}\s+accessibilityHint=\{disabledReason \?\? undefined\}/);
    expect(sheet).toContain('if (!draft || !sheet || sending || !online) return;');
  });

  it('the sizes are asked for only online, on the first Exchange, once (a failure waits for Try again)', () => {
    expect(sheet).toContain("if (!wantsSizes || !online || options.state !== 'idle') return;");
    expect(sheet.match(/getRequesterExchangeOptions\(/g)).toHaveLength(1);
    expect(sheet).toContain('const wantsSizes = !!draft && exchangesOn && draftWantsSizes(draft);');
  });

  it('no outbox kind, no queue: the sheet, its client and its rules never reach the offline stores', () => {
    for (const file of [SHEET_FILE, 'src/lib/requester-returns-api.ts', 'src/lib/requester-returns.ts', 'src/lib/use-requester-return.ts']) {
      expect(code(read(file)), file).not.toMatch(/from '(\.\/|@\/lib\/)(queue|outbox|adjust-outbox|db|sync)'/);
    }
    const queue = code(read('src/lib/queue.ts'));
    const kinds = queue.slice(queue.indexOf('export type PendingActionKind'), queue.indexOf(';', queue.indexOf('export type PendingActionKind')));
    expect(kinds).not.toMatch(/return/i);
  });

  it('nothing closes it while a request is under way', () => {
    expect(sheet).toMatch(/const close = \(\) => \{\s*if \(sending\) return;\s*onClose\(\);\s*\};/);
    expect(sheet).toContain('<Modal visible transparent animationType="slide" onRequestClose={close}>');
  });
});

describe('the sheet: one request key per draft', () => {
  it('the draft (and its key) comes only from openRequesterDraft; the sheet never mints a key itself', () => {
    expect(sheet).toContain('sheet ? openRequesterDraft({ scope, orderId, sheet }) : null');
    expect(sheet).not.toMatch(/randomRequestUuid|mintReturnKey|newRequesterDraft/);
  });

  it('kept in memory as it changes; forgotten once the server answered; renewed after a conflict', () => {
    expect(sheet).toMatch(/React\.useEffect\(\(\) => \{\s*if \(draft\) rememberRequesterDraft\(scope, orderId, draft\);\s*\}, \[draft, scope, orderId\]\);/);
    expect(sheet).toMatch(/const answer = await sendRequesterReturn\(orderId, built\.body\);\s*forgetRequesterDraft\(scope, orderId\);\s*onSent\(/);
    expect(sheet).toContain('if (requesterRefusalNeedsNewKey(e)) setDraft((d) => (d ? withNewRequesterKey(d) : d));');
  });

  it('a refusal that means the sheet is behind reads it, and the sizes, again', () => {
    expect(sheet).toMatch(/if \(requesterRefusalRefreshes\(e\)\) \{\s*setOptions\(\{ state: 'idle' \}\);\s*onReloadSheet\(\);\s*\}/);
  });
});

describe('the sheet: VoiceOver', () => {
  const t = treeOf(SHEET_FILE, 'RequesterReturnSheet');
  const a = (el: JsxNode, name: string) => attrText(el, name, t.sf);

  it('the scrim is a labelled Close that closes for VoiceOver too; the container keeps VoiceOver inside', () => {
    const container = t.nodes.find((n) => a(n.el, 'accessibilityViewIsModal') === 'true');
    expect(container).toBeDefined();
    expect(a(container!.el, 'onAccessibilityEscape')).toBe('close');
    const scrim = t.nodes.find((n) => (a(n.el, 'style') ?? '').includes('StyleSheet.absoluteFill'));
    expect(scrim && tagOf(scrim.el, t.sf)).toBe('Pressable');
    expect(a(scrim!.el, 'accessibilityRole')).toBe('button');
    expect(a(scrim!.el, 'accessibilityLabel')).toBe('Close');
    expect(a(scrim!.el, 'onAccessibilityTap')).toBe('close');
    expect(a(scrim!.el, 'onPress')).toBe('close');
  });

  it('every field and the Send button are their own element (no touchable folds them in)', () => {
    const controls = t.nodes.filter((n) => ['TextInput', 'Button'].includes(tagOf(n.el, t.sf)));
    expect(controls.filter((n) => tagOf(n.el, t.sf) === 'TextInput')).toHaveLength(2);
    for (const n of controls) {
      expect(n.ancestors.some((p) => TOUCHABLE_TAG.test(tagOf(p, t.sf))), tagOf(n.el, t.sf)).toBe(false);
      expect(n.ancestors.some((p) => a(p, 'accessible') !== undefined && a(p, 'accessible') !== 'false')).toBe(false);
    }
    for (const n of controls.filter((x) => tagOf(x.el, t.sf) === 'TextInput')) {
      expect(a(n.el, 'accessibilityLabel'), 'a field says what it is').toBeTruthy();
    }
  });

  it('Return only or Exchange, each size and each reason are radio buttons with their state, in named groups', () => {
    expect(sheet.match(/accessibilityRole="radio"/g)).toHaveLength(3);
    expect(sheet.match(/accessibilityRole="radiogroup"/g)).toHaveLength(3);
    expect(sheet).toContain('accessibilityState={{ checked: on, disabled: sending }}');
    expect(sheet).toContain('accessibilityState={{ checked, disabled: sending }}');
    expect(sheet).toContain('accessibilityLabel={`${RETURNS_COPY.whatWouldYouLikeToDo} ${label}`}');
    expect(sheet).toContain('accessibilityLabel={`${RETURNS_COPY.replacementSiblings} for ${label}`}');
    // A size row reads its name, size and availability (requesterOptionRows).
    expect(sheet).toContain('accessibilityLabel={row.accessibilityLabel}');
  });

  it('the steppers are named for their line and the count is announced', () => {
    expect(sheet).toContain("accessibilityLabel={`${delta < 0 ? 'Return one fewer' : 'Return one more'} ${label}`}");
    expect(sheet).toContain('accessibilityLiveRegion="polite"');
  });

  it('a refusal, and a failed read of the sheet, are announced when they appear (iOS does not announce role alert)', () => {
    expect(sheet).toMatch(/React\.useEffect\(\(\) => \{\s*if \(error\) AccessibilityInfo\.announceForAccessibility\(error\);\s*\}, \[error\]\);/);
    expect(sheet).toMatch(/React\.useEffect\(\(\) => \{\s*if \(loadMessage\) AccessibilityInfo\.announceForAccessibility\(loadMessage\);\s*\}, \[loadMessage\]\);/);
  });
});

describe('the sheet: Dynamic Type, the keyboard and the iPad', () => {
  const t = treeOf(SHEET_FILE, 'RequesterReturnSheet');
  const a = (el: JsxNode, name: string) => attrText(el, name, t.sf);

  it('rows stack past the AX threshold; no text is ever cut, nothing shrinks the type', () => {
    expect(sheet).toContain('const stacked = shouldStackRow(fontScale);');
    expect(sheet).toContain("flexDirection: stacked ? 'column' : 'row'");
    expect(sheet).not.toContain('numberOfLines');
    expect(sheet).not.toContain('adjustsFontSizeToFit');
    // Item names (the line's and each size's) are content: never capped.
    for (const name of ['{label}', '{row.label}']) {
      const bodies = sheet.match(new RegExp(`<Body\\b[^>]*>\\s*${name.replace(/[{}.]/g, '\\$&')}\\s*</Body>`, 'g')) ?? [];
      expect(bodies.length, name).toBe(1);
      expect(bodies[0]).not.toContain('maxFontSizeMultiplier');
    }
    // Only chrome is capped: the title, the controls' glyphs and labels, the fields.
    for (const m of sheet.match(/maxFontSizeMultiplier=\{([A-Z_]+)\}/g) ?? []) {
      expect(m).toMatch(/TITLE_CAP|CONTROL_CAP|CHOICE_CAP|INPUT_CAP/);
    }
  });

  it('bounded by the space the keyboard leaves, the body the one part that scrolls', () => {
    expect(sheet).toContain('const layout = exceptionSheetLayout({ windowHeight: height, availableHeight, topInset: insets.top });');
    const card = t.nodes.find((n) => (a(n.el, 'style') ?? '').includes('styles.sheet'));
    expect(a(card!.el, 'style')).toContain('maxHeight: layout.sheetMaxHeight');
    expect(a(card!.el, 'onStartShouldSetResponder')).toBe('kb.claimTapOutside');
    expect(a(card!.el, 'onResponderRelease')).toBe('kb.onTapOutside');
    const bodies = t.nodes.filter((n) => tagOf(n.el, t.sf) === 'ScrollView');
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!.el;
    expect(a(body, 'ref')).toBe('attachBody');
    expect(a(body, 'onScroll')).toBe('kb.onBodyScroll');
    expect(a(body, 'onLayout')).toBe('kb.onBodyLayout');
    expect(a(body, 'onContentSizeChange')).toBe('kb.onBodyContentSizeChange');
    expect(a(body, 'keyboardDismissMode')).toBe('on-drag');
    expect(a(body, 'keyboardShouldPersistTaps')).toBe('handled');
    expect(a(body, 'style')).toContain('flexShrink: 1');
  });

  it("each note's block sits directly in the body and tells the keyboard where the focused field is", () => {
    // The body's one child is the list of blocks; each note is pushed as its own block.
    expect(sheet).toMatch(/contentContainerStyle=\{\{ gap: 12 \}\}[\s\S]*?>\s*\{body\}\s*<\/ScrollView>/);
    const inputs = t.nodes.filter((n) => tagOf(n.el, t.sf) === 'TextInput');
    for (const input of inputs) {
      expect(a(input.el, 'onFocus')).toMatch(/^\(\) => noteFocus\(/);
      expect(a(input.el, 'onBlur')).toBe('kb.onNoteBlur');
      expect(a(input.el, 'onLayout')).toMatch(/laidField\(/);
      const block = input.ancestors.at(-1)!;
      expect(tagOf(block, t.sf)).toBe('View');
      expect(a(block, 'onLayout')).toMatch(/laidBlock\(/);
      // The block is the top of its own JSX (pushed onto `body`), never nested.
      expect(input.ancestors).toHaveLength(1);
    }
    expect(sheet).toContain('kb.onSpanFocus(span?.block ?? null, span?.field ?? null);');
  });

  it('on the iPad RETURNING and REPLACEMENT sit side by side; on the phone they wrap', () => {
    expect(sheet).toContain("pair: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }");
    expect(sheet).toContain('side: { flexGrow: 1, flexBasis: 300');
    // Text labels and an arrow, never colour alone.
    expect(sheet).toContain('<Eyebrow>{RETURNS_COPY.returning}</Eyebrow>');
    expect(sheet).toContain('<Eyebrow>→ {RETURNS_COPY.replacement}</Eyebrow>');
  });
});

describe('the order screen', () => {
  it("offers it to the order's own requester who does not manage returns, with Returns on (the web's rule)", () => {
    expect(screen).toMatch(
      /const requesterGate = requesterReturnGate\(\{\s*orderStatus: order\?\.status \?\? null,\s*requesterUserId: order\?\.requesterUserId \?\? null,\s*viewerUserId: userId,\s*viewerCanManageReturns: canManageReturns,\s*returnsModuleOn: enabledModules\.has\('returns'\),\s*fulfilledTotal: order\?\.totalFulfilled \?\? 0,\s*\}\);/,
    );
  });

  it('reads the sheet with every order read, only for that person, never offline', () => {
    expect(screen).toMatch(
      /useRequesterReturn\(\{\s*orderId: order\?\.id \?\? null,\s*eligible: requesterGate,\s*reloadKey: order\?\.receivedAt \?\? null,\s*offline,\s*\}\)/,
    );
    const hook = code(read('src/lib/use-requester-return.ts'));
    expect(hook).toContain('if (offline) return;');
    // An answer for an earlier read never replaces a later one.
    expect(hook).toContain('if (seq.current === mine) setLoad({ state: \'ready\', sheet });');
  });

  it('the button goes through actionBtn (disabled offline, with the reason as its hint), the sheet gets the live state', () => {
    expect(screen).toContain("actionBtn(RETURNS_COPY.requesterReturnOrExchange, 'requester-return', openRequesterSheet)");
    expect(screen).toMatch(/<RequesterReturnSheet[\s\S]*?online=\{!offline\}[\s\S]*?\/>/);
    expect(screen).toContain('{requesterOpen && requesterGate && order ? (');
  });

  it("shows the requester's own requests in the server's sentences, each once, and staff's returns as before", () => {
    expect(screen).toContain('requesterView: requesterGate && !canReadReturns,');
    expect(screen).toContain('<Eyebrow>{RETURNS_COPY.requesterYourRequests}</Eyebrow>');
    expect(screen).toMatch(/returnsShown\.tracking\.map\(\(t, i\) => \(\s*<RequesterTrackingCard/);
    expect(screen).toContain('returnsShown.orderReturns.map((r) => (');
    expect(screen).toContain('canCreateReturn: showCreateReturn || showRequesterReturn,');
  });

  it('after the answer: closes, says so in core\'s words, and reads the order (and so the requests) again', () => {
    expect(screen).toMatch(
      /onSent=\{\(sent\) => \{\s*setRequesterOpen\(false\);\s*Alert\.alert\(requesterSentTitle\(sent\.exchange\), sent\.returnNumber \?\? undefined\);\s*void load\(\);\s*\}\}/,
    );
  });
});

describe("the requester's request card", () => {
  const card = code(read('src/components/requester-tracking-card.tsx'));
  it('is one VoiceOver element with the words in reading order, and no control', () => {
    expect(card).toContain('<View accessible accessibilityLabel={v.accessibilityLabel} style={{ gap: 8 }}>');
    expect(card).not.toMatch(/Pressable|onPress|Touchable/);
    expect(card).not.toContain('numberOfLines');
  });
});
