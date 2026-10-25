import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { FONT, RADIUS, SPACE, TYPE_CEILING, capTo, palette, type Palette } from './theme';

/**
 * RECEIVING A PO ON THE PHONE, READ AS SOURCE (redesign package P5.8).
 *
 * The receive screen (app/po/[id].tsx) and its attachments panel
 * (src/components/po-attachments.tsx) were on the light-only legacy theme
 * alias with system fonts, Menlo and emoji in their words, and stayed light
 * in dark mode. They follow the device now, on the per-mode palette, with the
 * reference scanner's dark camera chrome. These pin what had to survive and
 * what the package fixed:
 *
 *   - a receipt is posted once, with one idempotency key, after the
 *     over-receipt confirm; Scan, the quantities and Post receipt follow the
 *     same gates; accept-all receiving (no rejected quantity is asked for);
 *     every word, word for word (receipt-hash-wiring, stock-permission-ctas-
 *     wiring, order-f2-5-wiring and po-id-lists-wiring pin the rest);
 *   - the PO scanner takes ONE read per opening: the reports the camera sends
 *     after it (one a frame while the code stays in view, and the scanner
 *     takes a moment to slide away) never reach a line or stack a second
 *     "Not on this PO";
 *   - a purchase order that is not in the workspace on screen says so, in
 *     place of an empty receiving form whose Post receipt did nothing;
 *   - the camera's clock and battery are light over its dark bar;
 *   - the focused box scrolls clear of the keyboard; Post receipt is the one
 *     ink button and clears the home indicator; every control is a 44pt
 *     target with a role and a name;
 *   - a file removal the database refused is said, not passed in silence.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser (as scanner-structure.test.ts reads the Scan tab), and
 * each one's style sheets are built from its own source for both modes and
 * measured.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const PO = 'app/po/[id].tsx';
const ATTACH = 'src/components/po-attachments.tsx';

const MODES: [string, Palette][] = [
  ['light', palette('light')],
  ['dark', palette('dark')],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

function treeOf(file: string): ts.SourceFile {
  return parseTsx(sourceOf(file), file);
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The same, with every run of whitespace made one space. */
function flatCode(file: string): string {
  return codeOnly(sourceOf(file)).replace(/\s+/g, ' ');
}

function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (match(el, sf)) els.push(el);
  });
  return { sf, els };
}

function where(file: string, el: JsxNode, sf: ts.SourceFile): string {
  const { line } = sf.getLineAndCharacterOfPosition(el.getStart(sf));
  return `${file}:${line + 1} <${tagOf(el, sf)}>`;
}

/** The text an element renders, flattened: JSX text plus string literals. */
function textOf(node: ts.Node, sf: ts.SourceFile): string {
  let out = '';
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) out += ` ${n.text}`;
    else if (ts.isStringLiteral(n) && !ts.isJsxAttribute(n.parent)) out += ` ${n.text}`;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out.replace(/\s+/g, ' ').trim();
}

type Styles = Record<string, Record<string, unknown>>;

/**
 * Top-level declarations of a screen (functions and consts, by name), compiled
 * from the repository's own source (never from input) and run in a context
 * holding only what they use: the theme's tokens and a StyleSheet whose
 * create() hands the object back. Returns what each name evaluates to.
 */
function topLevel(file: string, names: string[]): Record<string, unknown> {
  const sf = treeOf(file);
  const parts: string[] = [];
  const found = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) {
      parts.push(st.getText(sf));
      found.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      const declared = st.declarationList.declarations.map((d) => d.name.getText(sf));
      if (declared.some((n) => names.includes(n))) {
        parts.push(st.getText(sf));
        declared.forEach((n) => found.add(n));
      }
    }
  }
  expect([...found].sort(), `${names.join(', ')} in ${file}`).toEqual(
    expect.arrayContaining([...names].sort()),
  );
  const js = ts.transpileModule(`${parts.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const StyleSheet = {
    create: <T>(o: T): T => o,
    hairlineWidth: 0.5,
    absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  };
  return new vm.Script(js).runInNewContext({
    StyleSheet,
    FONT,
    RADIUS,
    SPACE,
    TYPE_CEILING,
    capTo,
    palette,
  }) as Record<string, unknown>;
}

/** The screen's sheet for one mode, built by its own makeStyles. */
function stylesFor(file: string, c: Palette): Styles {
  const { makeStyles } = topLevel(file, ['makeStyles']) as {
    makeStyles: (c: Palette) => Styles;
  };
  return makeStyles(c);
}

const colour = (s: Styles, name: string, prop = 'color'): string => {
  const v = s[name]?.[prop];
  expect(typeof v, `${name}.${prop}`).toBe('string');
  return v as string;
};

describe('the receive screen and its attachments follow the device, on the per-mode palette', () => {
  it.each([PO, ATTACH])(
    '%s: off the light-only legacy alias and the single-mode accents',
    (file) => {
      const code = codeOnly(sourceOf(file));
      expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
      expect(code).not.toMatch(/\btheme\./);
      expect(code).not.toMatch(/import \{[^}]*\btheme\b[^}]*\} from '@\/lib\/theme'/);
      expect(code).not.toMatch(/\bACCENT\b/);
      // System faces and Menlo gave way to the app's three families.
      expect(code).not.toContain("'Menlo'");
      expect(code).not.toMatch(/fontWeight: '7/);
      // No word in the faint inks, no paper2 well.
      expect(code).not.toMatch(/\bc\.(ink4|ink5|paper2)\b/);
      // No fixed colour or translucent scrim, but the camera's own surface.
      expect(code).not.toMatch(/rgba?\(/);
      const hexes = code.match(/['"`]#[0-9a-f]{3,8}['"`]/gi) ?? [];
      expect(hexes).toEqual(file === PO ? ["'#0a0b09'"] : []);
    },
  );

  it.each([
    [PO, 'PO_STYLES'],
    [ATTACH, 'ATTACHMENT_STYLES'],
  ])('%s: its styles are built once per mode and picked by the device mode', (file, sheet) => {
    const code = flatCode(file);
    expect(code).toContain(
      `const ${sheet}: Record<ThemeMode, ReturnType<typeof makeStyles>> = { light: makeStyles(palette('light')), dark: makeStyles(palette('dark')), };`,
    );
    const picks = code.match(new RegExp(`const styles = ${sheet}\\[mode\\];`, 'g')) ?? [];
    // The screen and each part that draws with them (SizeRunCard, Metric).
    expect(picks.length).toBe(file === PO ? 3 : 1);
  });

  it.each(MODES)('%s: every word on the receive screen reads at AA on what it sits on', (_m, c) => {
    const s = stylesFor(PO, c);
    const page = colour(s, 'root', 'backgroundColor');
    const card = colour(s, 'lineCard', 'backgroundColor');
    const wash = colour(s, 'lineCardHighlighted', 'backgroundColor');
    const pairs: [string, string, string][] = [
      ['title', colour(s, 'title'), page],
      ['subtitle', colour(s, 'subtitle'), page],
      ['muted', colour(s, 'muted'), page],
      ['errorTitle', colour(s, 'errorTitle'), page],
      ['errorBody', colour(s, 'errorBody'), page],
      ['attachHint', colour(s, 'attachHint'), page],
      ['historyHeading', colour(s, 'historyHeading'), page],
      ['qtyLabel (notes)', colour(s, 'qtyLabel'), page],
      ['scanBtnText', colour(s, 'scanBtnText'), colour(s, 'scanBtn', 'backgroundColor')],
      ['lineName', colour(s, 'lineName'), card],
      ['lineMeta', colour(s, 'lineMeta'), card],
      ['metricLabel', colour(s, 'metricLabel'), card],
      ['metricValue', colour(s, 'metricValue'), card],
      ['metricCaption', colour(s, 'metricCaption'), card],
      ['qtyLabel', colour(s, 'qtyLabel'), card],
      ['fullyReceived', colour(s, 'fullyReceived'), card],
      ['Variance over (critText)', c.critText, card],
      // The line a scan just filled, on the accent wash for two seconds.
      ['lineName (filled)', colour(s, 'lineName'), wash],
      ['lineMeta (filled)', colour(s, 'lineMeta'), wash],
      ['metricLabel (filled)', colour(s, 'metricLabel'), wash],
      ['metricCaption (filled)', colour(s, 'metricCaption'), wash],
      ['qtyLabel (filled)', colour(s, 'qtyLabel'), wash],
      ['Variance over (filled)', c.critText, wash],
      ['qtyInput', colour(s, 'qtyInput'), colour(s, 'qtyInput', 'backgroundColor')],
      ['placeholder (qty)', c.ink3, colour(s, 'qtyInput', 'backgroundColor')],
      ['notesInput', colour(s, 'qtyInput'), colour(s, 'notesInput', 'backgroundColor')],
      ['placeholder (notes)', c.ink3, colour(s, 'notesInput', 'backgroundColor')],
      ['allBtnText', colour(s, 'allBtnText'), colour(s, 'allBtn', 'backgroundColor')],
      ['runName', colour(s, 'runName'), colour(s, 'runCard', 'backgroundColor')],
      ['runMeta', colour(s, 'runMeta'), colour(s, 'runCard', 'backgroundColor')],
      ['runSize', colour(s, 'runSize'), colour(s, 'runCard', 'backgroundColor')],
      ['runOrdered', colour(s, 'runOrdered'), colour(s, 'runCard', 'backgroundColor')],
      ['runDone', colour(s, 'runDone'), colour(s, 'runCard', 'backgroundColor')],
      ['runSubtotal', colour(s, 'runSubtotal'), colour(s, 'runCard', 'backgroundColor')],
      ['runSize (filled)', colour(s, 'runSize'), colour(s, 'runRowHighlighted', 'backgroundColor')],
      [
        'runOrdered (filled)',
        colour(s, 'runOrdered'),
        colour(s, 'runRowHighlighted', 'backgroundColor'),
      ],
      ['runInput', colour(s, 'runInput'), colour(s, 'runInput', 'backgroundColor')],
      ['partNoticeText', colour(s, 'partNoticeText'), colour(s, 'partNotice', 'backgroundColor')],
      ['partRetryText', colour(s, 'partRetryText'), colour(s, 'partRetry', 'backgroundColor')],
      ['historyNumber', colour(s, 'historyNumber'), colour(s, 'historyCard', 'backgroundColor')],
      ['historyDate', colour(s, 'historyDate'), colour(s, 'historyCard', 'backgroundColor')],
      ['historyMeta', colour(s, 'historyMeta'), colour(s, 'historyCard', 'backgroundColor')],
    ];
    for (const [name, fg, bg] of pairs) {
      expect(contrast(fg, bg), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // The scan-filled edge stands out from the card it replaces (a UI mark).
    expect(contrast(colour(s, 'lineCardHighlighted', 'borderColor'), card)).toBeGreaterThanOrEqual(
      AA_UI,
    );
    // The page is the device's paper, the cards its card.
    expect(page).toBe(c.paper);
    expect(card).toBe(c.card);
    expect(wash).toBe(c.accentWash);
  });

  it.each(MODES)('%s: every word in the attachments panel reads at AA on the card', (_m, c) => {
    const s = stylesFor(ATTACH, c);
    const card = colour(s, 'card', 'backgroundColor');
    expect(card).toBe(c.card);
    for (const name of ['title', 'muted', 'errorText', 'fileName', 'delete']) {
      expect(contrast(colour(s, name), card), name).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // The paperclip (ink3) beside each file name, a glyph.
    expect(contrast(c.ink3, card)).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('the camera chrome is dark in both modes and reads at AA', () => {
  const cam = topLevel(PO, ['CAMERA_PALETTE', 'CAMERA', 'cameraStyles']) as {
    CAMERA: Record<string, string>;
    cameraStyles: Styles;
  };

  it('draws the bar and the viewfinder from the dark palette, never the device mode', () => {
    const dark = palette('dark');
    expect(cam.CAMERA).toEqual({
      surface: '#0a0b09',
      ink: dark.ink,
      chip: dark.card,
      chipBorder: dark.ink4,
      reticle: dark.accent,
    });
    const code = flatCode(PO);
    expect(code).toContain("const CAMERA_PALETTE = palette('dark');");
    // The scanner modal draws only with cameraStyles.
    const modal = code.slice(
      code.indexOf('<Modal visible={scannerOpen}'),
      code.indexOf('</Modal>'),
    );
    expect(modal).not.toMatch(/\bstyles\./);
    expect(modal).not.toMatch(/\bc\./);
  });

  it('Cancel reads at AA on its chip; the chip and the finder stand out from the bar', () => {
    const s = cam.cameraStyles;
    expect(
      contrast(colour(s, 'closeText'), colour(s, 'closeBtn', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(
      contrast(colour(s, 'closeBtn', 'borderColor'), colour(s, 'bar', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_UI);
    expect(
      contrast(colour(s, 'corner', 'borderColor'), colour(s, 'viewfinder', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_UI);
  });

  // Mutation caught: the root's dark clock left over the black camera ground
  // in light mode (about 1.05:1).
  it('the clock and battery are light while the scanner is up', () => {
    const code = flatCode(PO);
    expect(code).toContain("import { StatusBar } from 'expo-status-bar';");
    expect(code).toMatch(
      /<Modal visible=\{scannerOpen\} animationType="slide" onRequestClose=\{\(\) => setScannerOpen\(false\)\} ?> <View style=\{cameraStyles\.root\}> <StatusBar style="light" \/>/,
    );
  });

  it('Cancel is a named button in a 44pt frame, capped at the chrome ceiling', () => {
    const code = flatCode(PO);
    expect(code).toMatch(
      /<Pressable onPress=\{\(\) => setScannerOpen\(false\)\} accessibilityRole="button" accessibilityLabel="Cancel" style=\{\(\{ pressed \}\) => \[cameraStyles\.closeFrame, pressed && \{ opacity: 0\.7 \}\]\} > <View style=\{cameraStyles\.closeBtn\}> <Text style=\{cameraStyles\.closeText\} numberOfLines=\{1\} maxFontSizeMultiplier=\{CLOSE_CAP\} ?> Cancel <\/Text>/,
    );
    expect(cam.cameraStyles.closeFrame).toMatchObject({ minHeight: 44, minWidth: 44 });
    expect(code).toContain('const CLOSE_CAP = capTo(13, TYPE_CEILING.chrome);');
  });

  it('the finder is decoration: taps and VoiceOver pass through it', () => {
    expect(flatCode(PO)).toContain('<View style={cameraStyles.frameWrap} pointerEvents="none">');
  });
});

describe('the PO scanner: one read per opening, the same seven codes', () => {
  const code = flatCode(PO);

  it('reads the same seven symbologies into the same handler', () => {
    expect(code).toContain('onBarcodeScanned={onScanned}');
    expect(code).toContain(
      "barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],",
    );
  });

  // Mutation caught: the guard dropped (every report of one opening fills the
  // line again and an unmatched code stacks an alert per report), or never
  // cleared (the second opening reads nothing).
  it('the first read is taken; every later report of the same opening is dropped before it can do anything', () => {
    const handler = code.slice(
      code.indexOf('function onScanned('),
      code.indexOf('async function postReceipt('),
    );
    expect(handler).toContain(
      'const code = data.trim(); if (!code) return; if (scanTakenRef.current) return; scanTakenRef.current = true; const match = lines.find((l) => l.item?.barcode === code || l.item?.sku === code); setScannerOpen(false);',
    );
    expect(handler).toContain("Alert.alert('Not on this PO', `${code} doesn't match any line.`);");
    expect(handler).toContain(
      'fillRemaining(match); setHighlightLineId(match.id); setTimeout(() => setHighlightLineId(null), 2000);',
    );
    const opener = code.slice(
      code.indexOf('async function openScanner('),
      code.indexOf('function onScanned('),
    );
    expect(opener).toContain('scanTakenRef.current = false; setScannerOpen(true);');
    expect(opener).toContain(
      "Alert.alert('Camera permission required', 'Allow camera access to scan barcodes.');",
    );
    expect(code).toContain('const scanTakenRef = React.useRef(false);');
  });

  it('"All" and a scan both fill what is left and set rejected to 0: everything received is accepted', () => {
    expect(code).toContain(
      "function fillRemaining(line: PoLine) { const remaining = Math.max(0, line.quantity_ordered - line.quantity_received); setField(line.id, 'received', String(remaining)); setField(line.id, 'rejected', '0'); }",
    );
    expect(code).toContain('qtyReceived: received, qtyAccepted: received, qtyRejected: 0,');
  });
});

describe('the receipt is posted once, as before', () => {
  const code = flatCode(PO);

  it('over-receipt asks first, guarded so a second tap cannot queue a second confirm', () => {
    expect(code).toContain('const over = overReceiptUnits(lines, draft); if (over > 0) {');
    expect(code).toContain(
      'if (confirmingRef.current || submittingRef.current) return; confirmingRef.current = true; Alert.alert( OVER_RECEIPT_CONFIRM_TITLE, overReceiptConfirmMessage(over),',
    );
    expect(code).toContain('text: OVER_RECEIPT_CONFIRM_LABEL, onPress: () => void sendReceipt(),');
  });

  it('one idempotency key per intent, kept for a retry and retired only after a post that landed', () => {
    expect(code).toContain(
      'if (submittingRef.current) return; submittingRef.current = true; setPosting(true);',
    );
    expect(code).toContain(
      'if (!idemKeyRef.current) { idemKeyRef.current = `mobile-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; } const idempotencyKey = idemKeyRef.current;',
    );
    expect(code).toContain(
      "idemKeyRef.current = null; Alert.alert( 'Posted', `Received ${payloadLines.length} line${payloadLines.length === 1 ? '' : 's'}.`, [{ text: 'OK', onPress: () => router.back() }], );",
    );
  });

  // Mutation caught: a second ink button, or Post receipt back to a custom
  // green bar.
  it('Post receipt is the one ink button on the screen, off while posting or with nothing left', () => {
    const { sf, els } = elements(PO, (el, s) => tagOf(el, s) === 'Button');
    const ink = els.filter((el) => attrText(el, 'variant', sf) === undefined);
    expect(ink.map((el) => textOf(el, sf))).toEqual(['Posting… Post receipt Fully received']);
    expect(attrText(ink[0]!, 'disabled', sf)).toBe('posting || !receivable');
    expect(attrText(ink[0]!, 'onPress', sf)).toBe('postReceipt');
    expect(code).toContain(
      "{posting ? 'Posting…' : receivable ? 'Post receipt' : 'Fully received'}",
    );
    // The other one is the failed load's Try again, outlined.
    expect(
      els.filter((el) => attrText(el, 'variant', sf) === 'outline').map((el) => textOf(el, sf)),
    ).toEqual(['Try again']);
  });

  it('the footer clears the home indicator', () => {
    expect(code).toContain('const insets = useSafeAreaInsets();');
    expect(code).toMatch(
      /\{readOnly \? null : \( <View style=\{styles\.footer\}> <Button block onPress=\{postReceipt\}[^>]*>[^<]*<\/Button> <View style=\{\{ height: Math\.max\(0, insets\.bottom - SPACE\.md\) \}\} \/> <\/View> \)\}/,
    );
  });

  // Mutation caught: the focused quantity or note left under the keyboard.
  it('the focused box scrolls clear of the keyboard', () => {
    expect(code).toContain(
      '<ScrollView contentContainerStyle={{ padding: SPACE.md, paddingBottom: 140 }} automaticallyAdjustKeyboardInsets >',
    );
  });
});

describe('a purchase order that is not in the workspace on screen', () => {
  const code = flatCode(PO);

  // Mutation caught: the old `if (po) setHeader(...)`, which kept an earlier
  // read's header (a workspace switch) or showed "PO · No supplier" with the
  // lines its other read could see and a Post receipt that did nothing.
  it('says it was not found, instead of an empty receiving form', () => {
    expect(code).toContain(
      'if (!po) { setHeader(null); setLines([]); setGroups({}); setReceipts([]); setLoading(false); return; }',
    );
    expect(code).toMatch(
      /\) : !header \? \( <View style=\{styles\.center\}> <Text style=\{styles\.errorBody\} accessibilityRole="alert"> This PO was not found, or you no longer have access to it\. <\/Text> <\/View> \) : \(/,
    );
    // The form, its attachments and its footer are drawn only for a PO found.
    const found = code.slice(code.indexOf(') : !header ? ('));
    expect(found.indexOf('<PoAttachments poId={id} />')).toBeGreaterThan(0);
    expect(found.indexOf('<View style={styles.footer}>')).toBeGreaterThan(0);
  });
});

describe('every control on the receive screen is a 44pt target with a role and a name', () => {
  it.each(MODES)('%s: Scan, All, Try again and the quantity boxes are at least 44pt', (_m, c) => {
    const s = stylesFor(PO, c);
    for (const name of ['scanBtn', 'allBtn', 'partRetry', 'qtyInput', 'runInput']) {
      expect(s[name]?.minHeight, name).toBe(44);
    }
    expect(s.allBtn?.minWidth).toBeGreaterThanOrEqual(44);
  });

  // Mutation caught: the camera emoji put back in the words ("📷 Scan"), or
  // the button left without a role.
  it('Scan is a button with a camera icon beside the same word; no emoji or check glyphs in the words', () => {
    const code = flatCode(PO);
    expect(code).toMatch(
      /\{readOnly \? null : \( <Pressable onPress=\{openScanner\} accessibilityRole="button" style=\{\(\{ pressed \}\) => \[styles\.scanBtn, pressed && \{ opacity: 0\.7 \}\]\} > <Camera size=\{16\} color=\{c\.ink\} strokeWidth=\{1\.75\} \/> <Text style=\{styles\.scanBtnText\} numberOfLines=\{1\} maxFontSizeMultiplier=\{SCAN_CAP\}> Scan <\/Text> <\/Pressable> \)\}/,
    );
    expect(code).not.toMatch(/📷|✓/u);
    // Fully received and Full keep their words, with a check icon beside them.
    expect(code).toContain(
      '<Check size={14} color={c.accent} strokeWidth={2} style={styles.checkIcon} /> <Text style={styles.fullyReceived}> Fully received — nothing left to receive on this line. </Text>',
    );
    expect(code).toContain(
      '<Check size={13} color={c.accent} strokeWidth={2} /> <Text style={styles.runDone}>Full</Text>',
    );
  });

  it('every Pressable on the screen says it is a button', () => {
    const { sf, els } = elements(PO, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els.length).toBeGreaterThanOrEqual(6);
    for (const el of els) {
      expect(attrText(el, 'accessibilityRole', sf), where(PO, el, sf)).toBe('button');
    }
  });

  it('each quantity box is named for VoiceOver, its line or its size, and its hint is muted ink', () => {
    const code = flatCode(PO);
    expect(code).toContain(
      "accessibilityLabel={`Received now: ${l.item?.name ?? 'Unknown item'}`}",
    );
    expect(code).toContain('accessibilityLabel={`Receiving size ${poSizeLabel(l.variantSize)}`}');
    expect(code).toContain('accessibilityLabel={RECEIPT_NOTES_LABEL}');
    expect(code.match(/placeholderTextColor=\{c\.ink3\}/g) ?? []).toHaveLength(3);
    expect(code.match(/keyboardType="decimal-pad"/g) ?? []).toHaveLength(2);
  });

  it('every word on the receive screen survives, word for word', () => {
    const code = flatCode(PO);
    for (const words of [
      'Could not load this PO',
      'Try again',
      'No lines on this PO.',
      '<Metric label="Ordered" value={l.quantity_ordered} />',
      '<Metric label="Already" value={l.quantity_received} />',
      'label="Variance"',
      'caption={remaining > 0 ? varianceCaption(variance) : undefined}',
      "{l.item?.name ?? 'Unknown item'}",
      "{l.item?.sku ?? '—'}",
      "{l.item?.barcode ? ` · ${l.item.barcode}` : ''}",
      '<Text style={styles.qtyLabel}>Received now</Text>',
      'All',
      'Size run · {lines.length} sizes · {totalOrdered} ordered',
      '{l.quantity_ordered} ord · {l.quantity_received} rec',
      '{poRunSubtotalLabel(subtotal, group.countingUnit)}',
      'Size runs did not load, so lines are shown one by one. Receiving still works.',
      'Receipt history',
      'Receipt history did not load, so past receipts and their totals are not shown.',
      "{r.status !== 'posted' ? ` · ${r.status}` : ''}",
      "by {r.received_by_name} · {r.accepted} accepted {r.rejected > 0 ? ` · ${r.rejected} rejected` : ''}",
      '<Text style={styles.qtyLabel}>{RECEIPT_NOTES_LABEL}</Text>',
      'placeholder="Anything to note about this delivery"',
      'Documents save as soon as you add them — you don&apos;t need to post a receipt to keep an attachment.',
      "{header?.supplier_name ?? 'No supplier'} · {poStatusLabel(header?.status)}",
      "{header?.po_number ?? 'PO'}",
      "Alert.alert( 'No destination', 'Set a destination warehouse on the web first, then come back.', );",
      "Alert.alert('Enter quantities', 'Receive at least one line first.');",
    ]) {
      expect(code).toContain(words);
    }
  });

  // Docket B10: the header's own four-status list printed a received or
  // cancelled PO's status as stored ("Acme · received"). It names every
  // status through the shared words (po-status.test.ts), and no screen-local
  // copy of the list is left to drift.
  it('the header names the status through the shared words, with no list of its own', () => {
    const code = flatCode(PO);
    expect(code).toContain("import { poStatusLabel } from '@/lib/po-status';");
    expect(code).not.toContain('labelForStatus');
    expect(code).not.toMatch(/=== 'partially_received'\) return/);
  });
});

describe('the attachments panel', () => {
  const code = flatCode(ATTACH);

  // Mutation caught: the glyphs put back in the words ("＋ Attach",
  // "📄 Scan Document", "📎 name").
  it('the plus, document and paperclip glyphs became icons beside the same words', () => {
    expect(code).not.toMatch(/＋|📄|📎/u);
    expect(code).toContain("import { Paperclip, Plus, ScanText } from 'lucide-react-native';");
    expect(code).toContain('<Plus size={15} color={c.ink} strokeWidth={1.75} />');
    expect(code).toContain('leading={<ScanText size={15} color={c.ink} strokeWidth={1.75} />}');
    expect(code).toContain('<Paperclip size={15} color={c.ink3} strokeWidth={1.75} />');
  });

  it('Attach and Scan Document are outlined (Post receipt is the ink button), 44pt, off while busy, for those who manage purchase orders', () => {
    const { sf, els } = elements(ATTACH, (el, s) => tagOf(el, s) === 'Button');
    expect(els.map((el) => textOf(el, sf))).toEqual(['Attach', 'Scan Document']);
    for (const el of els) {
      expect(attrText(el, 'variant', sf)).toBe('outline');
      expect(attrText(el, 'size', sf)).toBe('sm');
      expect(attrText(el, 'disabled', sf)).toBe('busy');
    }
    expect(attrText(els[0]!, 'onPress', sf)).toBe('addFile');
    expect(attrText(els[1]!, 'onPress', sf)).toBe('() => void scanDocument()');
    // Attach keeps its word beside the spinner while a file uploads.
    expect(code).toContain(
      'leading={ busy ? ( <ActivityIndicator color={c.ink} size="small" /> ) : ( <Plus size={15} color={c.ink} strokeWidth={1.75} /> ) }',
    );
    expect(code.match(/\{canManage && \(/g) ?? []).toHaveLength(3);
    expect(code).toContain(
      "const canManage = permissions ? permissions.has('purchase_orders:manage') : isManagerOrAbove((activeRole ?? 'viewer') as Role);",
    );
  });

  it.each(MODES)(
    '%s: the panel is the reference card, and its controls are 44pt targets',
    (_m, c) => {
      const s = stylesFor(ATTACH, c);
      expect(s.card).toMatchObject({
        backgroundColor: c.card,
        borderColor: c.hair,
        borderWidth: 1,
        borderRadius: RADIUS.card,
      });
      // P5.4b: Attach dropped smallButton (the shared small Button's own
      // 44pt frame is its target); Scan Document, a full-width row action,
      // keeps its drawn 44pt.
      for (const name of ['scanButton', 'errorRow', 'fileOpen', 'removeFrame']) {
        expect(s[name]?.minHeight, name).toBe(44);
      }
      expect(s.smallButton).toBeUndefined();
      const { sf, els } = elements(ATTACH, (el, t) => tagOf(el, t) === 'Button');
      expect(els.map((el) => [attrText(el, 'size', sf), attrText(el, 'style', sf)])).toEqual([
        ['sm', undefined],
        ['sm', 'styles.scanButton'],
      ]);
      // The 44pt target is the shared small Button's own frame (P2.5c; drawn
      // and measured in components/ui/touch-target.test.ts).
      const smFrame = readSource(path.join(MOBILE_ROOT, 'src/components/ui/button.tsx'));
      expect(smFrame).toContain("const framed = size === 'sm';");
      expect(smFrame).toContain('export const BUTTON_MIN_TARGET = 44;');
      expect(smFrame).toMatch(
        /frame: \{\s*minHeight: BUTTON_MIN_TARGET,\s*minWidth: BUTTON_MIN_TARGET,/,
      );
    },
  );

  it('a file opens as a button; each Remove is a button that names its file', () => {
    const { sf, els } = elements(ATTACH, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els).toHaveLength(3);
    for (const el of els) {
      expect(attrText(el, 'accessibilityRole', sf), where(ATTACH, el, sf)).toBe('button');
    }
    expect(code).toContain("accessibilityLabel={`Remove ${row.file_name ?? 'File'}`}");
  });

  // Mutation caught: the delete's answer ignored again (a refused removal
  // re-read the list with the file still in it and said nothing).
  it('a removal the database refused is said; the list is read again either way', () => {
    const del = code.slice(
      code.indexOf('function confirmDelete('),
      code.indexOf('return ( <View style={styles.card}>'),
    );
    expect(del).toContain('await supabase.storage.from(BUCKET).remove([row.storage_path]);');
    expect(del).toContain(
      "const { data: removed, error: removeError } = await supabase .from('po_attachments') .delete() .eq('id', row.id) .select('id'); if (removeError || !removed || removed.length === 0) { Alert.alert( 'Could not remove', removeError?.message || 'The file is still attached. Try again in a moment.', ); } await load();",
    );
    expect(del).toContain("Alert.alert('Remove file?', row.file_name ?? 'This file', [");
    expect(del).toContain(
      "{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive',",
    );
  });

  it('the upload bar shows the real transported share, only while a file is going up', () => {
    expect(code).toContain(
      '{busy && uploadPercent !== null && ( <View style={styles.progress}> <StockBar value={Math.max(4, uploadPercent)} max={100} kind="ok" height={4} /> </View> )}',
    );
    expect(code).toContain(
      'onProgress: (fraction) => setUploadPercent(Math.min(99, Math.floor(fraction * 100))),',
    );
  });

  it('keeps hosting the one-time scanner tip, and every word', () => {
    expect(code).toContain(
      '<ScannerTip visible={tipVisible} onContinue={() => closeScannerTip(true)} onRequestClose={() => closeScannerTip(false)} />',
    );
    for (const words of [
      'Attachments',
      'Couldn’t load attachments — tap to retry. ({loadError})',
      "{canManage ? 'No files yet. Add a photo or PDF of the packing slip.' : 'No files attached.'}",
      "{row.file_name ?? 'File'}",
      'Remove',
      "Alert.alert('Attach a file', 'Add a packing slip, photo, or PDF to this PO.', [",
      "{ text: 'Take Photo', onPress: () => void takePhoto() },",
      "{ text: 'Choose from Library', onPress: () => void pickFromLibrary() },",
      "{ text: 'Choose File (PDF)', onPress: () => void pickDocument() },",
      "'Couldn’t open file', 'No download link is available right now. Pull to refresh and try again.',",
      "Alert.alert('File too large', 'Files must be 15 MB or smaller.');",
    ]) {
      expect(code).toContain(words);
    }
  });
});
