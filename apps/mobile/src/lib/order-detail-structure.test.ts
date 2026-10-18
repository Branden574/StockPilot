import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { buttonTone, meterColor, meterTrack, pillTone, toggleTone } from '../components/ui/tones';
import {
  TOUCHABLE_TAG,
  attrText,
  hasContent,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { returnStatusTone } from './returns-view';
import { palette, type Palette } from './theme';

/**
 * THE ORDER SCREEN AND ITS SHEETS, READ AS SOURCE (redesign package P5.7a;
 * rows M-OR-02 order detail, 02a DigitalPick, 02b signatures, 02c the order
 * sheets, 02d proof of delivery).
 *
 * The order screen (app/order/[id].tsx), the sheets it opens and the
 * packing-slip signature pad took the redesign look on the per-mode palette:
 * no fixed colours (the fixed amber, red, green and blue read under AA in one
 * mode or the other), no mode-independent ACCENT, informational words in
 * muted ink (ink3) instead of the decoration ink (ink4), status words on the
 * shared tone pills, the shared button hierarchy (ink for the step that
 * commits, outline for the rest, a refusal in refusal-red words, never a
 * full red bar), and 44pt targets with no hitSlop. The look is what moved.
 * These pin what had to survive it: every word, role, name and state, the
 * gates, the white signature surface and its gesture, the sheet shape
 * VoiceOver needs, and the defects this package fixed (each named below).
 *
 * The mobile suite has no React Native renderer, so the files are read with
 * the TypeScript parser (as scanner-structure.test.ts and
 * sheet-a11y-structure.test.ts read theirs); a pure rule that lives in a
 * screen file is run from its own source; colours are measured in both modes
 * with the palette they come from.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const FILES = {
  order: 'app/order/[id].tsx',
  addItems: 'src/components/add-order-items-sheet.tsx',
  editLine: 'src/components/edit-order-line-sheet.tsx',
  partial: 'src/components/approve-partial-sheet.tsx',
  revise: 'src/components/revise-needed-by-sheet.tsx',
  shortfall: 'src/components/draft-shortfall-po-sheet.tsx',
  pick: 'src/components/digital-pick.tsx',
  lineReadiness: 'src/components/order-line-readiness.tsx',
  summary: 'src/components/order-readiness-summary.tsx',
  neededByCard: 'src/components/order-needed-by-card.tsx',
  picker: 'src/components/needed-by-picker.tsx',
  signature: 'src/components/signature-pad-modal.tsx',
} as const;

const MODES: [string, Palette][] = [
  ['light', palette('light')],
  ['dark', palette('dark')],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const flat = (s: string) => s.replace(/\s+/g, ' ');

type Found = { el: JsxNode; ancestors: JsxNode[] };

/** Every element of a file, with its JSX ancestors (outermost first). */
function treeOf(file: string): { sf: ts.SourceFile; all: Found[] } {
  const sf = parseTsx(sourceOf(file), file);
  const all: Found[] = [];
  walkJsx(sf, (el, ancestors) => all.push({ el, ancestors: [...ancestors] }));
  return { sf, all };
}

/** The words an element shows: JSX text and string literals, children joined. */
function textOf(node: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
    else if (ts.isStringLiteral(n) && !ts.isJsxAttribute(n.parent)) parts.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return parts.filter(Boolean).join(' ');
}

/** Everything a person can read or hear in a file: JSX text and literals. */
function wordsOf(file: string): string[] {
  const sf = parseTsx(sourceOf(file), file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * A top-level function of a screen file, compiled from the repository's own
 * source and run in an empty context that holds only `deps`: the rule the
 * screen draws with, never a copy of it.
 */
function runFunction<T>(file: string, name: string, deps: Record<string, unknown>): T {
  const sf = parseTsx(sourceOf(file), file);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  expect(fn, `${name} in ${file}`).toBeDefined();
  const text = fn!.getText(sf).replace(/^export\s+/, '');
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new vm.Script(`${js}\n${name};`).runInNewContext({ ...deps }) as T;
}

/** The element a sheet's container holds: [scrim, card]. */
function kids(el: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(el)) return [];
  return el.children.filter(
    (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
  );
}

// ── The palette, on every file this package restyled ──────────────────────

describe('the per-mode palette on the order screen, its sheets and the signature pad', () => {
  const all = Object.values(FILES);

  // Mutation caught: a single-mode accent back as a word or a fill (ACCENT.warn
  // read 3.4:1 on the light page, ACCENT.crit 3.1-3.3:1 on the dark one).
  it.each(all)(
    '%s reads no mode-independent ACCENT, no paper2, no legacy theme, no MintWash',
    (file) => {
      const code = codeOnly(sourceOf(file));
      expect(code).not.toMatch(/\bACCENT\b/);
      expect(code).not.toMatch(/\bpaper2\b/);
      expect(code).not.toMatch(/\bMintWash\b/);
      expect(code).not.toMatch(/import \{[^}]*\btheme\b[^}]*\} from '@\/lib\/theme'/);
    },
  );

  // Mutation caught: a fixed hex colour back (#b45309 amber 3.5:1 on the light
  // card, #b42318 red, #16a34a green, #2563eb blue, #f8f9fa page). The only
  // fixed colours are the signature's: white in both modes, so the stored PNG
  // and the packing slip read the same, with near-black strokes on it.
  it.each(all)('%s names no fixed colour but the white signature surface', (file) => {
    const code = codeOnly(sourceOf(file));
    const hex = [...code.matchAll(/['"]#[0-9a-fA-F]{3,8}['"]/g)].map((m) => m[0]);
    const allowed: Record<string, string[]> = {
      [FILES.order]: ["'#fff'"],
      [FILES.signature]: ['"#1a1a1a"', '"#1a1a1a"', "'#fff'"],
    };
    expect(hex).toEqual(allowed[file] ?? []);
  });

  // Mutation caught: words or a placeholder back in the decoration ink (ink4,
  // 3.2-3.6:1, under AA). ink4 is left only on an arrow and the "nobody has it
  // yet" dot of the picker chip, both marks at 3:1 or more.
  it.each(all)('%s puts no words or placeholder in ink4 or ink5', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).not.toMatch(/\bc\.ink5\b/);
    expect(code).not.toMatch(/placeholderTextColor=\{c\.ink4\}/);
    for (const m of code.matchAll(/<(Body|Mono|Text|Eyebrow|FieldLabel|Display)\b[^>]*>/g)) {
      expect(m[0], `${file}: ${m[0].slice(0, 90)}`).not.toMatch(/c\.ink4/);
    }
    const uses = [...code.matchAll(/[^\n]*\bc\.ink4\b[^\n]*/g)].map((m) => m[0].trim());
    const marks: Record<string, string[]> = {
      [FILES.order]: ['backgroundColor: order.assignedPickerId ? c.accent : c.ink4,'],
      [FILES.shortfall]: ['<ChevronRight size={18} color={c.ink4} />'],
    };
    expect(uses).toEqual(marks[file] ?? []);
  });

  // The 44pt rule: a frame VoiceOver outlines where a finger can hit it, never
  // a hitSlop it does not see (the sign pad's X, the add sheet's X and Clear
  // search, the edit sheet's steppers, the tile's delete, Track package and
  // the RMA links all had one).
  it.each(all)('%s has no hitSlop', (file) => {
    expect(codeOnly(sourceOf(file))).not.toMatch(/\bhitSlop\b/);
  });

  it('ink4 marks and every word colour this package draws hold their ratio in both modes', () => {
    for (const [mode, c] of MODES) {
      for (const bg of [c.card, c.paper, c.sunk]) {
        for (const fg of [c.ink, c.ink2, c.ink3, c.warnText, c.critText]) {
          expect(contrast(fg, bg), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
      expect(contrast(c.ink4, c.card), `${mode} ink4 mark on card`).toBeGreaterThanOrEqual(AA_UI);
      expect(contrast(c.accent, c.card), `${mode} accent dot on card`).toBeGreaterThanOrEqual(
        AA_UI,
      );
      // The charter chip: the accent on its wash.
      expect(contrast(c.accent, c.accentWash), `${mode} charter chip`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      // An icon button's glyph (the sheets' X, the tile's delete).
      expect(contrast(c.ink2, c.card), `${mode} ink2 icon`).toBeGreaterThanOrEqual(AA_UI);
    }
  });
});

// ── The order screen ───────────────────────────────────────────────────────

describe('order screen: the order actions keep their tones, and a refusal is never a red bar', () => {
  const src = sourceOf(FILES.order);
  const code = codeOnly(src);

  it('actionBtn draws with the shared tones: ink for the commit, the outline for the rest, refusal words for danger', () => {
    expect(code).toContain(
      "const tones = buttonTone(tone === 'primary' ? 'primary' : 'outline', c);",
    );
    expect(code).toContain("const fg = tone === 'danger' ? c.critText : tones.fg;");
    expect(code).toContain('borderColor: tones.border,');
    expect(code).toContain('<Text style={[styles.actionLabel, { color: fg }]}>{label}</Text>');
    for (const [mode, c] of MODES) {
      const ink = buttonTone('primary', c);
      const outline = buttonTone('outline', c);
      expect(contrast(ink.fg, ink.bg), `${mode} ink words`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(outline.fg, outline.bg), `${mode} outline words`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      expect(contrast(c.critText, outline.bg), `${mode} refusal words`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });

  // Which action is the ink commit and which is the outline or a refusal:
  // exactly as before the restyle (mutation caught: a tone moved).
  it('every action keeps its tone', () => {
    const sf = parseTsx(src, FILES.order);
    const calls: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'actionBtn'
      ) {
        const [label, , , tone] = n.arguments;
        calls.push(`${label!.getText(sf)} ${tone ? tone.getText(sf) : "'primary'"}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(calls).toEqual([
      "'Add items' 'default'",
      "'Claim picking' 'primary'",
      "'Release' 'default'",
      "'Approve' 'primary'",
      "'Approve partial' 'default'",
      "'Deny' 'danger'",
      "'Generate pick slip' 'primary'",
      "RETURNS_COPY.releaseBeforeReturn 'default'",
      "'Generate packing slips' 'primary'",
      "'Reopen picking' 'danger'",
      "'Mark staged for pickup' 'primary'",
      "'Mark staged for delivery' 'primary'",
      "'Reopen picking' 'danger'",
      "order.assignedDeliveryUserId ? 'Reassign delivery' : 'Assign delivery' 'default'",
      "'Mark in transit' 'primary'",
      "'Collect signature' 'primary'",
      "'Physical signature' 'default'",
      "'Resume fulfillment' 'primary'",
      "'Close as delivered-partial' 'default'",
      "cancelOffer.label 'danger'",
      "'Email delivery request' 'primary'",
      "'Copy details' 'default'",
      "'Create return' 'primary'",
      "requesterEntryWords(requester.load) 'primary'",
    ]);
  });

  it('Deny and Reopen picking confirm in the outline with refusal words, with the same gates', () => {
    const f = flat(code);
    expect(f).toContain(
      '<Pressable onPress={() => void submitDeny()} disabled={acting !== null} accessibilityRole="button" style={[ styles.addBtn, { ...outlineButton, paddingHorizontal: 18, opacity: acting !== null ? 0.5 : 1 }, ]} > <Text style={[styles.actionLabel, { color: c.critText }]}>Deny</Text>',
    );
    expect(f).toContain(
      'onPress={() => void reopenPicking()} disabled={!reopenReason.trim() || acting !== null} accessibilityRole="button"',
    );
    expect(f).toContain(
      '<Text style={[styles.actionLabel, { color: c.critText }]}>Reopen picking</Text>',
    );
    expect(
      code.match(/<Text style=\{\[styles\.actionLabel, \{ color: c\.ink \}\]\}>Cancel<\/Text>/g),
    ).toHaveLength(2);
    // The reasons are still required; the typed reason is in the body face.
    expect(code).toContain('placeholder="Reason"');
    expect(code).toContain('placeholder="Why is this being reopened? (e.g. miscount on line 3)"');
    expect(code).toMatch(
      /reasonInput: \{\s*minHeight: 72,[\s\S]*?fontFamily: FONT\.displayRegular,/,
    );
  });

  it('the button words are the shared display face, uncapped, and wrap inside a button that grows', () => {
    const label = src.match(/\n {2}actionLabel: \{[^}]*\}/)?.[0] ?? '';
    expect(label).toContain('fontFamily: FONT.display');
    expect(label).toContain('flexShrink: 1');
    const addBtn = src.match(/\n {2}addBtn: \{[^}]*\}/)?.[0] ?? '';
    expect(addBtn).toMatch(/minHeight: 44,/);
    expect(addBtn).not.toMatch(/[^A-Za-z]height: 44/);
  });
});

describe('order screen: words, roles and states survive the restyle', () => {
  const words = wordsOf(FILES.order);

  it.each([
    'Backordered — awaiting stock',
    'Partially fulfilled',
    'Pick slip out of date',
    'This order has no items yet.',
    'Tap a line to change its quantity or take it off the order.',
    'Items already on this order are topped up rather than listed twice.',
    'PICKING',
    'This order is being picked by someone else.',
    'Same actions as the web dashboard — changes sync instantly.',
    'MANAGER ACTIONS',
    'ORDER ACTIONS',
    'Resume unlocks when owed items are back in stock.',
    'ORDER',
    'DELIVERY REQUEST',
    'Delivery request text to copy manually',
    'Open the return →',
    'A return is a later event — the shipped count above is never rewritten.',
    'View signature',
    'SHIPPING',
    'Track package',
    'PROOF OF DELIVERY',
    'Add proof',
    'Available once the order is out for delivery or completed.',
    'Managers can add proof of delivery here.',
    'No attachments yet.',
    'Open',
    'Delete attachment',
    'Customer signature',
    'Tap anywhere to close',
    'Deny this request?',
    'The requester is notified with the reason you provide.',
    'Reopen picking?',
    'Create return',
    'REASON',
    'NOTES',
    'Optional notes for the approver',
    'Submit return',
    'Assign delivery',
    'No team members found.',
    'Wet signature',
    'Items dropped off',
    'Drop-off location',
    'Other',
    'Label not purchased',
    'Delivery failed',
  ])('says "%s"', (word) => {
    expect(words).toContain(word);
  });

  it('a backordered or part-fulfilled order: the warning ink and the shared meter, measured', () => {
    const code = codeOnly(sourceOf(FILES.order));
    expect(code).toContain('backgroundColor: meterTrack(c),');
    expect(code).toContain("backgroundColor: meterColor('warn', c),");
    expect(code).toMatch(
      /<Body size=\{13\} color=\{c\.warnText\} style=\{\{ flexShrink: 1 \}\}>\s*\{order\.status === 'backordered'/,
    );
    for (const [mode, c] of MODES) {
      expect(
        contrast(meterColor('warn', c), meterTrack(c)),
        `${mode} bar on track`,
      ).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  // Mutation caught: a proof kind chip back to an unnamed, stateless 28pt box.
  it('the proof kinds are choices VoiceOver hears with their state, in 44pt frames', () => {
    const { sf, all } = treeOf(FILES.order);
    const chips = all.filter((n) => attrText(n.el, 'onPress', sf) === '() => setKind(k)');
    expect(chips).toHaveLength(1);
    const chip = chips[0]!.el;
    expect(attrText(chip, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(chip, 'accessibilityState', sf)).toBe('{ selected: on }');
    expect(attrText(chip, 'style', sf)).toContain('minHeight: MIN_TAP');
    expect(flat(chip.getText(sf))).toContain(
      '<Body size={13} color={on ? c.paper : c.ink2} maxFontSizeMultiplier={CHIP_CAP}> {KIND_LABELS[k]} </Body>',
    );
  });

  it('a proof tile opens as a named button; delete is a named 44pt button, managers only, off offline', () => {
    const { sf, all } = treeOf(FILES.order);
    const open = all.filter((n) => attrText(n.el, 'onPress', sf) === '() => openAttachment(a)');
    expect(open).toHaveLength(1);
    expect(attrText(open[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(open[0]!.el, 'accessibilityLabel', sf)).toBe("KIND_LABELS[a.kind] ?? 'Other'");
    const del = all.filter(
      (n) => attrText(n.el, 'onPress', sf) === '() => void deleteAttachment(a)',
    );
    expect(del).toHaveLength(1);
    expect(attrText(del[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(del[0]!.el, 'accessibilityLabel', sf)).toBe('Delete attachment');
    expect(attrText(del[0]!.el, 'accessibilityState', sf)).toBe('{ disabled: offline }');
    expect(attrText(del[0]!.el, 'disabled', sf)).toBe('offline');
    expect(attrText(del[0]!.el, 'style', sf)).toBe(
      '[styles.tileDelete, { opacity: offline ? 0.4 : 1 }]',
    );
    expect(sourceOf(FILES.order)).toMatch(
      /\n {2}tileDelete: \{\s*minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/,
    );
    expect(flat(codeOnly(sourceOf(FILES.order)))).toContain(
      '{isManager ? ( <Pressable onPress={() => void deleteAttachment(a)}',
    );
  });

  it('a photo sits on white in both modes, a file on the recessed fill', () => {
    const code = codeOnly(sourceOf(FILES.order));
    expect(code).toContain('style={[styles.tileImg, { backgroundColor: PHOTO_BACKGROUND }]}');
    expect(code).toMatch(/gap: 4, backgroundColor: c\.sunk \}/);
  });

  it('retrying the attachments, opening the signature and the tracking page are named for VoiceOver, at 44pt', () => {
    const { sf, all } = treeOf(FILES.order);
    const press = (fn: string) => all.filter((n) => attrText(n.el, 'onPress', sf) === fn);
    const retry = press('() => void loadAttachments()');
    expect(retry).toHaveLength(1);
    expect(attrText(retry[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(retry[0]!.el, 'style', sf)).toContain('minHeight: MIN_TAP');
    const sig = press('() => setSigOpen(true)');
    expect(sig).toHaveLength(1);
    expect(attrText(sig[0]!.el, 'accessibilityRole', sf)).toBe('button');
    const track = all.filter((n) =>
      (attrText(n.el, 'onPress', sf) ?? '').includes('shipment.tracking_url'),
    );
    expect(track).toHaveLength(1);
    expect(attrText(track[0]!.el, 'accessibilityRole', sf)).toBe('link');
    expect(attrText(track[0]!.el, 'style', sf)).toContain('minHeight: MIN_TAP');
  });

  it("an RMA's status is its tone's pill, in the same words", () => {
    const code = codeOnly(sourceOf(FILES.order));
    expect(code).toMatch(
      /<Pill status=\{returnStatusTone\(r\.status\)\} dot=\{false\}>\s*\{returnStatusLabel\(r\.status\)\.toUpperCase\(\)\}\s*<\/Pill>/,
    );
    for (const status of ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled']) {
      for (const [mode, c] of MODES) {
        const tone = pillTone(returnStatusTone(status), c);
        expect(contrast(tone.fg, tone.bg), `${mode} ${status}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('the charter chip and the picker dot take the per-mode accent', () => {
    const code = codeOnly(sourceOf(FILES.order));
    expect(code).toContain('backgroundColor: c.accentWash,');
    expect(code).toContain('<Landmark size={10} color={c.accent} />');
    expect(code).toContain('backgroundColor: order.assignedPickerId ? c.accent : c.ink4,');
  });

  it('Add proof is the outline (the order step keeps the one ink button), with the same gate', () => {
    const f = flat(codeOnly(sourceOf(FILES.order)));
    expect(f).toContain(
      '<Pressable onPress={addProof} disabled={uploading || offline} accessibilityRole="button" accessibilityState={{ disabled: uploading || offline }} style={[ styles.addBtn, { ...outlineButton, opacity: uploading || offline ? 0.6 : 1 }, ]} >',
    );
    expect(f).toContain('<Camera size={16} color={c.ink} strokeWidth={1.8} />');
  });

  it('the photo viewer stays dark in both modes and a tap anywhere closes it', () => {
    const { sf, all } = treeOf(FILES.order);
    const viewer = all.filter((n) => attrText(n.el, 'onPress', sf) === '() => setViewerUrl(null)');
    expect(viewer).toHaveLength(1);
    expect(attrText(viewer[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(viewer[0]!.el, 'style', sf)).toContain("backgroundColor: 'rgba(0,0,0,0.92)'");
  });
});

describe('order screen: the driver and create-return sheets are the shared sheet shape (defect fixed)', () => {
  const { sf, all } = treeOf(FILES.order);

  // Neither had it: VoiceOver could wander out of the sheet, the scrim was an
  // unnamed element, and the driver sheet's X had no name or role at all.
  /** An attribute's source text with its whitespace folded, so a pin does
   *  not depend on how deep the element is indented. */
  const attrFlat = (el: JsxNode, name: string) => {
    const t = attrText(el, name, sf);
    return t === undefined ? undefined : flat(t);
  };
  const CLOSE_RETURN = '() => { if (!returnSubmitting) setReturnOpen(false); }';

  function containerOf(scrimPress: string) {
    const scrims = all.filter(
      (n) =>
        attrFlat(n.el, 'onPress') === scrimPress &&
        (attrText(n.el, 'style', sf) ?? '').includes('StyleSheet.absoluteFill'),
    );
    expect(scrims, scrimPress).toHaveLength(1);
    const scrim = scrims[0]!;
    const container = scrim.ancestors[scrim.ancestors.length - 1]!;
    return { scrim: scrim.el, container, parent: scrim.ancestors[scrim.ancestors.length - 2] };
  }

  it.each([
    ['the driver sheet', '() => setDriverOpen(false)'],
    ['the create-return sheet', CLOSE_RETURN],
  ])('%s: a named Close scrim behind a plain card, VoiceOver kept inside', (_name, press) => {
    const { scrim, container } = containerOf(press);
    expect(tagOf(scrim, sf)).toBe('Pressable');
    expect(hasContent(scrim)).toBe(false);
    expect(attrText(scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrFlat(scrim, 'onAccessibilityTap')).toBe(press);
    expect(attrFlat(container, 'onAccessibilityEscape')).toBe(press);
    expect(attrText(container, 'accessibilityViewIsModal', sf)).toBe('true');
    expect(attrText(container, 'onAccessibilityEscape', sf)).toBeDefined();
    const [first, card] = kids(container);
    expect(first).toBe(scrim);
    expect(tagOf(card!, sf)).toBe('View');
    for (const prop of ['onPress', 'accessible', 'onStartShouldSetResponder']) {
      expect(attrText(card!, prop, sf)).toBeUndefined();
    }
  });

  it('the X on both sheets is a named 44pt button', () => {
    for (const press of ['() => setDriverOpen(false)', CLOSE_RETURN]) {
      const xs = all.filter(
        (n) =>
          attrFlat(n.el, 'onPress') === press && kids(n.el).some((ch) => tagOf(ch, sf) === 'X'),
      );
      expect(xs, press).toHaveLength(1);
      expect(attrText(xs[0]!.el, 'accessibilityRole', sf)).toBe('button');
      expect(attrText(xs[0]!.el, 'accessibilityLabel', sf)).toBe('Close');
      expect(attrText(xs[0]!.el, 'style', sf)).toBe('styles.closeFrame');
    }
    expect(sourceOf(FILES.order)).toMatch(
      /\n {2}closeFrame: \{\s*minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/,
    );
  });

  it('each driver is a button VoiceOver hears with the name and email, at 44pt', () => {
    const rows = all.filter((n) =>
      (attrText(n.el, 'onPress', sf) ?? '').includes("action: 'assign_delivery'"),
    );
    expect(rows).toHaveLength(1);
    expect(attrText(rows[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(rows[0]!.el, 'style', sf)).toContain('minHeight: MIN_TAP');
  });

  // The defect: NOTES sits low in this bottom-anchored sheet, and the sheet had
  // no keyboard-avoiding wrapper, so the keyboard covered the note being typed
  // and Submit return, while the scrim above the keyboard closed the sheet.
  // Mutation caught: the wrapper dropped, or the space it leaves not measured.
  it('the create-return sheet rides above the keyboard, sized by the space it leaves', () => {
    const { container, parent } = containerOf(CLOSE_RETURN);
    expect(parent && tagOf(parent, sf)).toBe('KeyboardAvoidingView');
    expect(attrText(parent!, 'behavior', sf)).toBe("Platform.OS === 'ios' ? 'padding' : undefined");
    expect(attrText(container, 'onLayout', sf)).toBe(
      '(e) => setReturnAvailableHeight(e.nativeEvent.layout.height)',
    );
    const code = flat(codeOnly(sourceOf(FILES.order)));
    expect(code).toContain(
      'const returnSheetLayout = exceptionSheetLayout({ windowHeight, availableHeight: returnAvailableHeight, topInset: sheetInsets.top, });',
    );
  });

  it('Restock / Scrap, Return / Exchange and the reasons are radios with their state, in 44pt chips', () => {
    const radios = all.filter((n) => attrText(n.el, 'accessibilityRole', sf) === 'radio');
    expect(radios).toHaveLength(3);
    for (const r of radios) {
      expect(attrText(r.el, 'accessibilityState', sf)).toBe(
        '{ checked: on, disabled: returnSubmitting }',
      );
      expect(attrText(r.el, 'style', sf)).toContain('styles.choice');
    }
    expect(sourceOf(FILES.order)).toMatch(/\n {2}choice: \{\s*minHeight: MIN_TAP,/);
  });

  it('"The item is here" keeps its switch, name and hint, drawn in the shared toggle recipe', () => {
    const f = flat(codeOnly(sourceOf(FILES.order)));
    expect(f).toContain(
      '<Switch value={returnItemIsHere} onValueChange={setReturnItemIsHere} disabled={returnSubmitting} accessibilityLabel={RETURNS_COPY.itemIsHere} accessibilityHint={RETURNS_COPY.itemIsHereHelp}',
    );
    expect(f).toContain('thumbColor={toggleTone(returnItemIsHere, c).knob}');
    for (const [mode, c] of MODES) {
      for (const on of [true, false]) {
        const t = toggleTone(on, c);
        expect(contrast(t.knob, t.track), `${mode} ${on}`).toBeGreaterThanOrEqual(AA_UI);
      }
    }
  });
});

// ── The sheets ─────────────────────────────────────────────────────────────

describe('add items sheet: the shared sheet shape and 44pt targets (defects fixed)', () => {
  const { sf, all } = treeOf(FILES.addItems);
  const code = codeOnly(sourceOf(FILES.addItems));

  // The scrim was an unnamed Pressable and the container kept VoiceOver
  // nowhere: VoiceOver could leave the sheet, and its two-finger scrub did
  // nothing. Mutation caught: any of the four props dropped.
  it('a named Close scrim behind a plain card; VoiceOver stays inside; Escape and a double-tap close', () => {
    const scrims = all.filter(
      (n) =>
        attrText(n.el, 'onPress', sf) === 'requestClose' &&
        (attrText(n.el, 'style', sf) ?? '').includes('StyleSheet.absoluteFill'),
    );
    expect(scrims).toHaveLength(1);
    const scrim = scrims[0]!;
    expect(attrText(scrim.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim.el, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(scrim.el, 'onAccessibilityTap', sf)).toBe('requestClose');
    const container = scrim.ancestors[scrim.ancestors.length - 1]!;
    expect(attrText(container, 'accessibilityViewIsModal', sf)).toBe('true');
    expect(attrText(container, 'onAccessibilityEscape', sf)).toBe('requestClose');
  });

  // Close was an 18pt X with a hitSlop and no role; Clear search the same;
  // Load more had no role. Mutation caught: a frame or a role dropped.
  it('Close, Clear search and Load more are named buttons in 44pt frames', () => {
    const touch = all.filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)));
    const byLabel = (label: string) =>
      touch.find((n) => attrText(n.el, 'accessibilityLabel', sf) === label)!;
    const close = touch.filter((n) => attrText(n.el, 'style', sf) === 'styles.close');
    expect(close).toHaveLength(1);
    expect(attrText(close[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(close[0]!.el, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(byLabel('Clear search').el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(byLabel('Clear search').el, 'style', sf)).toBe('styles.clearSearch');
    const more = touch.filter((n) => attrText(n.el, 'onPress', sf) === '() => void loadMore()');
    expect(more).toHaveLength(1);
    expect(attrText(more[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(more[0]!.el, 'style', sf)).toContain('minHeight: MIN_TAP');
    const src = sourceOf(FILES.addItems);
    expect(src).toMatch(/\n {2}close: \{\s*minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/);
    expect(src).toMatch(/\n {2}clearSearch: \{\s*minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/);
  });

  // The search box and Add to order had a fixed 44pt height around words that
  // grow with the text size, so at the largest sizes the typed words and the
  // button's label were cut. Mutation caught: a fixed height back. The typed
  // words stay uncapped, as before (content is never capped).
  it('the search box and Add to order grow with the text (minHeight, never a fixed height)', () => {
    const src = sourceOf(FILES.addItems);
    expect(src).not.toMatch(/[^A-Za-z]height: 44\b/);
    expect(src).toMatch(/\n {2}searchBox: \{[^}]*minHeight: MIN_TAP,/);
    expect(src).toMatch(/\n {2}submit: \{[^}]*minHeight: MIN_TAP,/);
    const { sf, all } = treeOf(FILES.addItems);
    const inputs = all.filter((n) => tagOf(n.el, sf) === 'TextInput');
    expect(inputs).toHaveLength(1);
    expect(attrText(inputs[0]!.el, 'maxFontSizeMultiplier', sf)).toBeUndefined();
  });

  it('Add to order is the ink button and keeps its words beside the spinner; the refusal is an alert', () => {
    expect(code).toMatch(
      /\{submitting \? <ActivityIndicator color=\{c\.paper\} \/> : null\}\s*<Text\s+style=\{\[styles\.submitLabel, \{ color: c\.paper \}\]\}\s+maxFontSizeMultiplier=\{ACTION_CAP\}\s*>\s*Add to order\s*<\/Text>/,
    );
    expect(code).toContain('accessibilityState={{ disabled: submitting, busy: submitting }}');
    expect(code).toMatch(
      /<Body size=\{13\} color=\{c\.critText\} accessibilityRole="alert">\s*\{error\}/,
    );
  });

  it('keeps every word', () => {
    const words = wordsOf(FILES.addItems);
    for (const w of [
      'Add items',
      'Only items stocked at this order',
      'Search by name, SKU, barcode',
      'Search items to add to this order',
      'Could not load items. Check your connection and try again.',
      'Already on this order — adding tops it up',
      'Add to order',
      'Could not add items',
    ]) {
      expect(
        words.some((x) => x.includes(w)),
        w,
      ).toBe(true);
    }
  });
});

describe('edit line sheet: buttons, steppers and the quantity box grow with the text (defect fixed)', () => {
  const src = sourceOf(FILES.editLine);
  const code = codeOnly(src);

  // A fixed 44pt height cut a wrapped "Lower to what was picked (30)" at the
  // largest text sizes, and the quantity box clipped its typed number; the
  // steppers were 40pt boxes widened by a hitSlop VoiceOver never sees.
  it('no fixed heights; the steppers are 44pt frames', () => {
    expect(src).not.toMatch(/[^A-Za-z]height: 44\b/);
    expect(src).toMatch(/\n {2}action: \{[^}]*minHeight: MIN_TAP,/);
    expect(src).toMatch(/\n {2}qtyInput: \{[^}]*minHeight: MIN_TAP,/);
    expect(code).toMatch(
      /minWidth: MIN_TAP,\s*minHeight: MIN_TAP,\s*borderRadius: 10,\s*borderWidth: 1,\s*borderColor: c\.hair2,/,
    );
    // The typed quantity stays uncapped, as before; the box grows with it.
    const { sf, all } = treeOf(FILES.editLine);
    const inputs = all.filter((n) => tagOf(n.el, sf) === 'TextInput');
    expect(inputs).toHaveLength(1);
    expect(attrText(inputs[0]!.el, 'maxFontSizeMultiplier', sf)).toBeUndefined();
  });

  it("Save quantity is the ink button; Remove and a short line's remove say so in the refusal ink", () => {
    expect(code).toContain('const inkText = [styles.actionLabel, { color: ink.fg }];');
    expect(code).toContain('const refusalText = [styles.actionLabel, { color: c.critText }];');
    expect(code).toContain('<Eyebrow color={c.warnText}>{shortFix.label}</Eyebrow>');
    expect(code).toMatch(/<Body size=\{12\} color=\{c\.warnText\}>\s*\{raiseWarning\}/);
    const words = wordsOf(FILES.editLine);
    for (const w of [
      'Edit line',
      'QUANTITY',
      'Quantity ordered',
      'Remove from order',
      'Save quantity',
      'Keep it',
      'Remove item',
      'Increase quantity',
      'Decrease quantity',
      'Enter a whole number above zero.',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe("draft PO sheet: each line's box is the shared CheckboxMark (P2.5b hand-off)", () => {
  const { sf, all } = treeOf(FILES.shortfall);

  it('the row Pressable is the checkbox VoiceOver hears; the mark inside it draws the box and its disabled look', () => {
    const boxes = all.filter((n) => attrText(n.el, 'accessibilityRole', sf) === 'checkbox');
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!.el;
    expect(tagOf(box, sf)).toBe('Pressable');
    expect(attrText(box, 'onPress', sf)).toBe(
      '() => edit(toggleShortfallChoice(selection, view, row.itemId))',
    );
    expect(attrText(box, 'disabled', sf)).toBe('!row.draftable || locked');
    expect(attrText(box, 'accessibilityLabel', sf)).toBe('row.accessibilityLabel');
    expect(attrText(box, 'accessibilityState', sf)).toBe(
      '{ checked: row.checked, disabled: !row.draftable || locked }',
    );
    const marks = all.filter((n) => tagOf(n.el, sf) === 'CheckboxMark');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.ancestors).toContain(box);
    expect(attrText(marks[0]!.el, 'checked', sf)).toBe('row.checked');
    expect(attrText(marks[0]!.el, 'disabled', sf)).toBe('!row.draftable || locked');
    // The quantity field is never inside the checkbox.
    const inputs = all.filter((n) => tagOf(n.el, sf) === 'TextInput');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.ancestors).not.toContain(box);
    expect(codeOnly(sourceOf(FILES.shortfall))).not.toMatch(/\bCheckCircle2\b|\bCircle\b/);
  });

  it("the quantity sits in the reference's count input, warned in the per-mode warning ink", () => {
    const code = codeOnly(sourceOf(FILES.shortfall));
    expect(code).toContain('borderColor: row.problem ? c.warnText : c.hair2,');
    expect(code).toContain('backgroundColor: c.sunk,');
  });
});

describe('approve partial, revise needed-by and draft PO: the shared button tones', () => {
  it.each([FILES.partial, FILES.revise, FILES.shortfall])(
    '%s: the commit in ink, Cancel or Close in the outline',
    (file) => {
      const code = codeOnly(sourceOf(file));
      expect(code).toContain("const ink = buttonTone('primary', c);");
      expect(code).toContain("const outline = buttonTone('outline', c);");
      expect(code).toContain('const inkText = [styles.actionLabel, { color: ink.fg }];');
      expect(code).toContain('const outlineText = [styles.actionLabel, { color: outline.fg }];');
      expect(code.match(/maxFontSizeMultiplier=\{ACTION_CAP\}/g)).toHaveLength(2);
      expect(code).toMatch(/<X size=\{18\} color=\{c\.ink2\} \/>/);
    },
  );
});

// ── DigitalPick, readiness and the needed-by card ──────────────────────────

describe('DigitalPick: one ink button, the line saves as outlines (M-OR-02a)', () => {
  const code = codeOnly(sourceOf(FILES.pick));

  it("Complete picking is the 52pt ink button; a line's Save is the outline whose edge turns ink while unsaved", () => {
    expect(code).toMatch(
      /minHeight: Math\.max\(MIN_TAP, 52\),[\s\S]*?borderRadius: BUTTON_RADIUS\.md,[\s\S]*?backgroundColor: c\.ink,/,
    );
    expect(code).toContain('borderColor: dirty ? c.ink : c.hair2,');
    expect(code).toContain('backgroundColor: c.card,');
    expect(code).not.toMatch(/backgroundColor: dirty \? c\.ink/);
    // Words and gates unchanged.
    expect(code).toContain("{savingLine === line.id ? 'Saving…' : dirty ? 'Save' : 'Saved'}");
    expect(code).toContain('disabled={!dirty || savingLine === line.id || offline}');
    expect(code).toContain('disabled={!anyPicked || completing || offline}');
    expect(code).toMatch(
      /'Completing…'\s*: allPicked\s*\? 'Complete picking'\s*: 'Complete picking \(partial\)'/,
    );
  });

  it('the count input, the charter chip and a failed read in the per-mode tokens', () => {
    expect(code).toMatch(/borderColor: c\.hair2,\s*backgroundColor: c\.sunk,/);
    expect(code).toContain('backgroundColor: c.accentWash,');
    expect(code).toMatch(
      /<Body size=\{13\} color=\{c\.critText\} accessibilityRole="alert">\s*\{error\}/,
    );
    const words = wordsOf(FILES.pick);
    for (const w of [
      'Being picked by another picker.',
      'Tap to retry',
      'DIGITAL PICKING',
      'Fill all as requested',
      'Could not save pick',
      'Could not complete picking',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe("readiness: the state chip is the reference's status label, per mode, run from its own source", () => {
  // Compiled inside each test (never at collection), so a missing or broken
  // rule fails its own test instead of the whole file.
  const chipTone = (tone: string, c: Palette) =>
    runFunction<(tone: string, c: Palette) => { fg: string; bg: string; border: string }>(
      FILES.lineReadiness,
      'readinessChipTone',
      { pillTone },
    )(tone, c);
  const toneColor = (tone: string, c: Palette) =>
    runFunction<(tone: string, c: Palette) => string>(
      FILES.lineReadiness,
      'readinessToneColor',
      {},
    )(tone, c);

  it('each tone takes its wash, its words at AA on it, in both modes', () => {
    for (const [mode, c] of MODES) {
      expect(chipTone('success', c)).toEqual(pillTone('ok', c));
      expect(chipTone('warning', c)).toEqual(pillTone('warn', c));
      expect(chipTone('danger', c)).toEqual(pillTone('crit', c));
      expect(chipTone('info', c)).toEqual({ fg: c.ink2, bg: c.sunk, border: c.hair2 });
      expect(chipTone('neutral', c)).toEqual(pillTone('default', c));
      for (const tone of ['success', 'warning', 'danger', 'info', 'neutral']) {
        const t = chipTone(tone, c);
        expect(contrast(t.fg, t.bg), `${mode} ${tone}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it("the roll-up's icon takes its tone's per-mode ink, readable on the card", () => {
    for (const [mode, c] of MODES) {
      expect(toneColor('success', c)).toBe(c.accent);
      expect(toneColor('warning', c)).toBe(c.warnText);
      expect(toneColor('danger', c)).toBe(c.critText);
      expect(toneColor('info', c)).toBe(c.ink2);
      expect(toneColor('neutral', c)).toBe(c.ink3);
      for (const tone of ['success', 'warning', 'danger', 'info', 'neutral']) {
        expect(contrast(toneColor(tone, c), c.card), `${mode} ${tone}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    }
    expect(codeOnly(sourceOf(FILES.summary))).toContain('<Body size={13.5} color={c.warnText}>');
  });

  it('Change on the needed-by card is the outline, its label capped and its words kept', () => {
    const code = codeOnly(sourceOf(FILES.neededByCard));
    expect(code).toContain("const outline = buttonTone('outline', c);");
    expect(code).toMatch(
      /<Text style=\{labelText\} maxFontSizeMultiplier=\{BUTTON_CAP\}>\s*\{NEEDED_BY_CHANGE_LABEL\}/,
    );
  });
});

// ── The signature pad ──────────────────────────────────────────────────────

describe("signature pad (M-OR-02b): the device's mode around a capture surface that stays white", () => {
  const src = sourceOf(FILES.signature);
  const code = codeOnly(src);
  const { sf, all } = treeOf(FILES.signature);

  it.each([
    'Sign Order',
    'Full Name *',
    'Email *',
    'Signature *',
    'Your full name',
    'your@email.com',
    'Draw your signature above',
    'Clear',
    'Saving…',
    'Save Signature',
    'Required',
    'Please enter your name.',
    'Please enter your email.',
    'Signature required',
    'Please draw your signature before saving.',
    'Signature pad not ready. Please try again.',
    'Failed to capture signature. Please try again.',
    'Failed to save signature. Please try again.',
  ])('says "%s"', (word) => {
    expect(wordsOf(FILES.signature)).toContain(word);
  });

  // The pad prints on the packing slip and shows on the web, both on white.
  it('the capture surface: white, near-black strokes, in a frame of the per-mode stronger border', () => {
    expect(code).toContain(
      '<Rect x={0} y={0} width={padWidth} height={PAD_HEIGHT} fill="white" />',
    );
    expect(code.match(/stroke="#1a1a1a"/g)).toHaveLength(2);
    expect(code).toContain("svg: { backgroundColor: '#fff' },");
    expect(code).toContain('<View style={[styles.padWrapper, { borderColor: c.hair2 }]}>');
    expect(contrast('#1a1a1a', '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // The PanResponder holds the whole stroke and the pad never sits in a
  // scroll view (a scroll stole the drag before).
  it('the gesture is unchanged, and nothing scrolls the pad', () => {
    expect(flat(code)).toContain(
      'PanResponder.create({ onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true, onPanResponderTerminationRequest: () => false, onShouldBlockNativeResponder: () => true, onPanResponderGrant: (evt) => { Keyboard.dismiss();',
    );
    expect(code).toContain('{...panResponder.panHandlers}');
    expect(code).not.toMatch(/ScrollView|KeyboardAwareScrollView/);
    expect(code).toContain('if (submitting) return;');
  });

  // The close control was a TouchableOpacity showing the glyph "✕", with no
  // name or role: VoiceOver read the glyph. Mutation caught: the glyph back,
  // the name dropped.
  it('Close is a named 44pt icon button, not a glyph', () => {
    expect(code).not.toContain('✕');
    expect(code).not.toMatch(/TouchableOpacity/);
    const chips = all.filter((n) => tagOf(n.el, sf) === 'IconChip');
    expect(chips).toHaveLength(1);
    expect(attrText(chips[0]!.el, 'icon', sf)).toBe('X');
    expect(attrText(chips[0]!.el, 'onPress', sf)).toBe('onClose');
    expect(attrText(chips[0]!.el, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(chips[0]!.el, 'minTap', sf)).toBe('true');
  });

  it('Save Signature is the ink button (off while it saves), Clear its outline', () => {
    const buttons = all.filter((n) => tagOf(n.el, sf) === 'Button');
    expect(
      buttons.map((b) => [
        textOf(b.el, sf),
        attrText(b.el, 'variant', sf),
        attrText(b.el, 'onPress', sf),
        attrText(b.el, 'disabled', sf),
      ]),
    ).toEqual([
      ['Clear', 'outline', 'handleClear', undefined],
      ['Saving… Save Signature', undefined, '() => void handleSave()', 'submitting'],
    ]);
    expect(code).toContain("{submitting ? 'Saving…' : 'Save Signature'}");
  });

  it('the text boxes are the shared Field, named by their labels, typed words uncapped as before', () => {
    const fields = all.filter((n) => tagOf(n.el, sf) === 'Field');
    expect(
      fields.map((f) => [
        attrText(f.el, 'label', sf),
        attrText(f.el, 'accessibilityLabel', sf),
        attrText(f.el, 'maxFontSizeMultiplier', sf),
        attrText(f.el, 'value', sf),
      ]),
    ).toEqual([
      ['Full Name *', 'Full Name', '0', 'signerName'],
      ['Email *', 'Email', '0', 'signerEmail'],
    ]);
  });

  // The modal set no status bar: in dark mode the host's light words sat on
  // its light page (about 1.05:1). Now the page follows the mode and the
  // modal sets the bar to match, run here for both modes.
  it('the page and the status bar follow the mode, and the bar reads on the page', () => {
    expect(code).toContain('style={[styles.container, { backgroundColor: c.paper }]}');
    const bars = all.filter((n) => tagOf(n.el, sf) === 'StatusBar');
    expect(bars).toHaveLength(1);
    const expr = attrText(bars[0]!.el, 'style', sf)!;
    expect(expr).toBe("mode === 'dark' ? 'light' : 'dark'");
    for (const [mode, c] of MODES) {
      const style = new vm.Script(expr).runInNewContext({ mode }) as string;
      const words = style === 'light' ? '#ffffff' : '#000000';
      expect(contrast(words, c.paper), `${mode} status bar on the page`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });
});
