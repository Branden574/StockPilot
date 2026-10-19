import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast, hexOf, rgbOf } from '../components/ui/__fixtures__/contrast';
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
import { actionsForStatus } from './po-import-approve';
import { FONT, RADIUS, SPACE, TYPE_CEILING, capTo, palette, type Palette } from './theme';

/**
 * THE PO IMPORT REVIEW AND SCAN A PO, READ AS SOURCE (redesign package P5.8).
 *
 * The import review (app/po-import/[id].tsx) was already on the per-mode
 * palette, but its words leant on the faint ink4 and the single-mode ACCENT
 * warn and crit (under AA in one mode or the other), and its approve sheet
 * was not shaped for VoiceOver. Scan a PO (app/scan-po/index.tsx) was on the
 * light-only legacy theme alias and stayed light in dark mode, with a sparkle
 * emoji in its Extract words. These pin what had to survive and what the
 * package fixed:
 *
 *   - every word, field, gate and write path, word for word (the approve
 *     sheet's WAREHOUSE, VENDOR, RECEIVE INTO, the two charters, the expected
 *     date and the unmatched-line decisions; the scan's names, modes, stages
 *     and outcomes);
 *   - the review: the footer's buttons one under the other, Cancel import the
 *     refusal-red words and one ink button; the parsed lines scroll clear of
 *     the footer however tall it grows; a first read that failed can be tried
 *     again; the approve sheet keeps VoiceOver inside it and its scrim is a
 *     "Close" button; the date box is named and grows with the text;
 *   - Scan a PO: the camera's dark chrome with a named Done and shutter; one
 *     photo at a time and one extraction per tap; never more than five pages
 *     (the scan route refuses a sixth for the whole scan); the mode choice is
 *     a pair of radio buttons; each page's hold-to-remove is an action for
 *     VoiceOver; the progress still says Done only after the server answered.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser (as po-receive-structure.test.ts reads the receive
 * screen), and Scan a PO's style sheets are built from its own source for
 * both modes and measured.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const REVIEW = 'app/po-import/[id].tsx';
const SCAN = 'app/scan-po/index.tsx';

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

type Located = { el: JsxNode; ancestors: JsxNode[] };

/** Every element of a file (or of one of its functions) with its ancestors. */
function nodesOf(file: string, fnName?: string): { sf: ts.SourceFile; nodes: Located[] } {
  const sf = treeOf(file);
  let root: ts.Node = sf;
  if (fnName) {
    const fn = sf.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === fnName,
    );
    expect(fn, `${fnName} in ${file}`).toBeDefined();
    root = fn!;
  }
  const nodes: Located[] = [];
  walkJsx(root, (el, ancestors) => nodes.push({ el, ancestors: [...ancestors] }));
  return { sf, nodes };
}

function jsxChildren(el: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(el)) return [];
  return el.children.filter(
    (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
  );
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

/** Every word a file shows: its JSX text and its string literals. */
function wordsOf(file: string): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) && n.text.trim()) out.push(n.text.trim());
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Why this element is not its own VoiceOver element, or null when it is. */
function collapsedBy(ancestors: JsxNode[], sf: ts.SourceFile): string | null {
  for (const a of ancestors) {
    const tag = tagOf(a, sf);
    if (TOUCHABLE_TAG.test(tag)) return `inside <${tag}>`;
    const accessible = attrText(a, 'accessible', sf);
    if (accessible !== undefined && accessible !== 'false') return `inside <${tag} accessible>`;
  }
  return null;
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

const colour = (s: Styles, name: string, prop = 'color'): string => {
  const v = s[name]?.[prop];
  expect(typeof v, `${name}.${prop}`).toBe('string');
  return v as string;
};

/** 'rgba(r, g, b, a)' laid over an opaque colour, as '#rrggbb'. */
function over(rgba: string, ground: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(rgba);
  expect(m, rgba).not.toBeNull();
  const [r, g, b, a] = [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
  const [gr, gg, gb] = rgbOf(ground);
  const mix = (top: number, bottom: number) => Math.round(top * a + bottom * (1 - a));
  return hexOf(
    `#${[mix(r, gr), mix(g, gg), mix(b, gb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The import review
// ─────────────────────────────────────────────────────────────────────────────

describe('the import review is on the per-mode palette, its words at AA', () => {
  const code = codeOnly(sourceOf(REVIEW));

  it('no single-mode accents, legacy alias, faint inks or fixed colours', () => {
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    // ACCENT's warn and crit were the "SUPERSEDED" eyebrow, the mapping
    // warning, the parse and action errors and the date box's refusal: under
    // AA as words in one mode or the other.
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/\btheme\./);
    // ink4 named words here (the source type, vendor and date, uploader, stat
    // labels, line meta, field labels, every picker note); paper2 was the
    // date box's fill (the card colour in dark).
    expect(code).not.toMatch(/\bc\.(ink4|ink5|paper2)\b/);
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    // The only translucent colours: the app's per-mode sheet scrim and grabber.
    expect((code.match(/rgba\([^)]*\)/g) ?? []).sort()).toEqual(
      [
        'rgba(0,0,0,0.55)',
        'rgba(14,15,13,0.18)',
        'rgba(14,15,13,0.35)',
        'rgba(250,250,247,0.22)',
      ].sort(),
    );
  });

  it.each(MODES)('%s: the colours its words take read at AA on the card and the page', (_m, c) => {
    for (const [name, fg] of [
      ['ink', c.ink],
      ['ink2 (a linked item)', c.ink2],
      ['ink3 (meta, labels, notes, placeholders)', c.ink3],
      ['warnText (superseded, mapping, item names, refresh)', c.warnText],
      ['critText (parse and action errors, the date refusal)', c.critText],
    ] as const) {
      expect(contrast(fg, c.card), `${name} on the card`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(fg, c.paper), `${name} on the page`).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // The date box's refusal edge and its focused ink edge on the card (UI).
    expect(contrast(c.critText, c.card)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(c.ink, c.card)).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('the import review keeps its gates, actions and words', () => {
  const code = flatCode(REVIEW);

  it('the actions follow the same manager or purchase_orders:manage gate and status', () => {
    expect(code).toContain(
      "const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);",
    );
    expect(code).toContain(
      "const canManage = isManager || (role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage'));",
    );
    expect(code).toContain(
      'const actions = header && canManage ? actionsForStatus(header.status) : [];',
    );
  });

  // Mutation caught: a second ink button in the footer. Parse file (or
  // Retry parse) and Approve… are both the ink button, and the statuses never
  // offer both at once.
  it('the footer shows at most one ink button: parse and approve never come together', () => {
    for (const status of [
      'uploaded',
      'parsing',
      'parsed',
      'needs_review',
      'approved',
      'failed',
      'duplicate',
      'canceled',
      'anything else',
    ]) {
      const actions = actionsForStatus(status);
      expect(actions.includes('parse') && actions.includes('approve'), status).toBe(false);
    }
  });

  // Mutation caught: the buttons side by side again ("Cancel import" lost its
  // words to an ellipsis), Cancel import back to ink words, the order or a
  // gate changed.
  it('the footer: one full-width button under the other, in the same order, with the same gates', () => {
    expect(code).toContain(
      "{actions.includes('cancel') ? ( <Button block variant=\"destructive\" disabled={actionBusy !== null} onPress={confirmCancel} > {actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel import'} </Button> ) : null} {actions.includes('parse') ? ( <Button block disabled={actionBusy !== null} onPress={() => void runParse()}> {actionBusy === 'parse' ? 'Parsing…' : header.status === 'failed' ? 'Retry parse' : 'Parse file'} </Button> ) : null} {actions.includes('approve') ? ( <Button block disabled={actionBusy !== null || itemNamesError !== null} onPress={() => { if (itemNamesError !== null) return; setActionError(null); setApproveOpen(true); }} > Approve… </Button> ) : null}",
    );
    expect(code).not.toContain(
      "<View style={{ flexDirection: 'row', gap: 10 }}> {actions.includes",
    );
    expect(code).toContain(
      '{actionError ? ( <Mono size={11.5} color={c.critText} style={{ lineHeight: 16 }}> {actionError} </Mono> ) : null}',
    );
    expect(code).toContain(
      "{actions.includes('approve') && itemNamesError !== null ? ( <Mono size={11.5} color={c.warnText} style={{ lineHeight: 16 }}> Approve is unavailable until item names load, so every line can be checked against its item. Pull down to try again. </Mono> ) : null}",
    );
  });

  // Mutation caught: the fixed 160 again, under a footer an error and the
  // approve note made taller; or a footer in the home indicator's strip.
  it('the parsed lines scroll clear of the footer however tall it grows, and it clears the home indicator', () => {
    expect(code).toContain("import { footerReservation } from '@/lib/dynamic-type-layout';");
    expect(code).toContain(
      'paddingBottom: footerReservation(actions.length > 0 ? footerHeight : null, 160),',
    );
    expect(code).toContain('onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}');
    expect(code).toContain('paddingBottom: Math.max(28, insets.bottom),');
    expect(code).toContain('const insets = useSafeAreaInsets();');
  });

  // Mutation caught: a first read that failed left with no way to read again.
  it('a first read that failed says why and can be tried again; a missing import says so', () => {
    expect(code).toContain(
      ") : !header ? ( <View style={{ padding: 24, alignItems: 'center', gap: 14 }}> <Body muted style={{ textAlign: 'center' }} accessibilityRole=\"alert\"> {loadError ?? 'This import was not found, or you no longer have access to it.'} </Body> {loadError !== null ? ( <Button variant=\"outline\" onPress={() => { setLoading(true); setLoadError(null); void load(); }} > Try again </Button> ) : null} </View> ) : (",
    );
    // A refresh that failed over an import on screen is still said, and now
    // announced.
    expect(code).toContain(
      '<Body size={12} color={c.warnText} accessibilityRole="alert"> Could not refresh this import: {loadError}. Pull down to try again. </Body>',
    );
  });

  it('every word on the review survives, word for word', () => {
    for (const words of [
      '<Eyebrow>PROCUREMENT · PO IMPORT</Eyebrow>',
      'Review <Em>import.</Em>',
      "uploaded: { label: 'UPLOADED', status: 'default' },",
      "parsing: { label: 'PARSING', status: 'warn' },",
      "parsed: { label: 'PARSED', status: 'ok' },",
      "needs_review: { label: 'REVIEW', status: 'warn' },",
      "approved: { label: 'APPROVED', status: 'ok' },",
      "failed: { label: 'FAILED', status: 'crit' },",
      "duplicate: { label: 'DUPLICATE', status: 'crit' },",
      "canceled: { label: 'CANCELLED', status: 'default' },",
      '— {header.source_type}',
      '{header.po_number ?? header.file_name}',
      "{header.vendor_name ? `${header.vendor_name} · ` : ''}",
      'Uploaded by {uploadedBy}',
      '<HeaderStat label="LINES" value={String(lines.length)} />',
      '<HeaderStat label="PO DATE" value={header.po_date ?? \'—\'} />',
      'label="TOTAL"',
      '{header.parse_error}',
      '— SUPERSEDED',
      'Replaced by a later import of this file.',
      'Open the newer import to see where it stands — if it was replaced in turn, it says so too. This import and the purchase order it created are kept unchanged for the record.',
      'Open the newer import',
      'This file was imported again later, so this is no longer the live import for it.',
      '— RE-IMPORT',
      "? `Re-import of ${predecessor.poNumber}, which was cancelled.` : 'This file was imported once before.'}",
      'The earlier import of {predecessor.fileName} is kept for the record.',
      'View the earlier import',
      'View created PO',
      '<Eyebrow>PARSED LINES</Eyebrow>',
      'Item names did not load. Pull down to try again.',
      "? 'No lines yet — parse the file to extract them.' : 'No lines were extracted from this file.'}",
      'LINE {line.line_number}',
      "{!isInventory ? ` · ${line.line_type}` : ''}",
      "{line.description?.trim() || 'No description'}",
      "{line.uom ? ` ${line.uom}` : ''} × {costText}",
      "{line.vendor_item_number ? ` · #${line.vendor_item_number}` : ''}",
      'Confirm column mapping in web review',
      '<Pill status="ok">MATCHED</Pill>',
      '<Pill status="warn">UNMATCHED</Pill>',
      '<Pill>{line.line_type.toUpperCase()}</Pill>',
      "'Cancel this import?'",
      "'The import is discarded and any items it auto-created (still unused) are archived. This cannot be undone.'",
      "{ text: 'Keep it', style: 'cancel' }",
      "text: 'Cancel import', style: 'destructive',",
      "Alert.alert('Approved', 'Purchase order created — it now expects receiving.', [",
      "text: 'View PO', onPress: () => router.replace({ pathname: '/po/[id]', params: { id: poId } }),",
      "e instanceof Error ? e.message : 'Could not re-parse this import.'",
      "e instanceof Error ? e.message : 'Could not cancel this import.'",
      'accessibilityLabel="Back"',
    ]) {
      expect(code).toContain(words);
    }
  });
});

describe('the approve sheet: VoiceOver stays inside it, and every field survives', () => {
  const { sf, nodes } = nodesOf(REVIEW, 'ApproveSheetContent');
  const containers = nodes.filter((n) => attrText(n.el, 'accessibilityViewIsModal', sf) === 'true');

  const shape = () => {
    expect(containers).toHaveLength(1);
    const container = containers[0]!;
    const kids = jsxChildren(container.el);
    expect(kids).toHaveLength(2);
    return { container, scrim: kids[0]!, card: kids[1]! };
  };

  // Mutation caught: the scrim back to an unnamed element (VoiceOver read
  // nothing), or a double-tap on it that lands on the card at the centre.
  it('the scrim is a childless "Close" button behind the card that closes the sheet', () => {
    const { scrim, card } = shape();
    expect(tagOf(scrim, sf)).toBe('Pressable');
    expect(hasContent(scrim)).toBe(false);
    expect(attrText(scrim, 'onPress', sf)).toBe('onClose');
    expect(attrText(scrim, 'onAccessibilityTap', sf)).toBe('onClose');
    expect(attrText(scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(scrim, 'style', sf)).toContain('StyleSheet.absoluteFill');
    expect(attrText(scrim, 'style', sf)).toContain(
      "mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'",
    );
    expect(tagOf(card, sf)).toBe('View');
  });

  it('the container keeps VoiceOver in the sheet and the escape scrub closes it; it sits in the keyboard wrapper', () => {
    const { container } = shape();
    expect(tagOf(container.el, sf)).toBe('View');
    expect(attrText(container.el, 'onAccessibilityEscape', sf)).toBe('onClose');
    expect(attrText(container.el, 'style', sf)).toBe("{ flex: 1, justifyContent: 'flex-end' }");
    const parent = container.ancestors[container.ancestors.length - 1];
    expect(parent && tagOf(parent, sf)).toBe('KeyboardAvoidingView');
  });

  it('every field, chip and button in the card is its own VoiceOver element', () => {
    const { card } = shape();
    const controls = nodes.filter(
      (n) =>
        n.ancestors.includes(card) &&
        ['TextInput', 'Button', 'Pressable', 'Chip'].includes(tagOf(n.el, sf)),
    );
    expect(controls.length).toBeGreaterThanOrEqual(10);
    for (const ctl of controls) {
      const above = ctl.ancestors.slice(ctl.ancestors.indexOf(card));
      expect(collapsedBy(above, sf), `${tagOf(ctl.el, sf)} in the card`).toBeNull();
    }
    expect(collapsedBy(shape().container.ancestors, sf)).toBeNull();
  });

  // Mutation caught: Cancel and Approve side by side again ("Approving…" ran
  // out of room at the larger sizes), or a second ink button.
  it('Cancel and Approve, one under the other; Approve is the one ink button and waits for every gate', () => {
    const code = flatCode(REVIEW);
    expect(code).toContain(
      "<View style={{ gap: 8, marginTop: 18 }}> <Button block variant=\"ghost\" onPress={onClose} disabled={submitting}> Cancel </Button> <Button block onPress={() => void submit()} disabled={!canSubmit}> {submitting ? 'Approving…' : 'Approve'} </Button> </View>",
    );
    expect(code).toContain(
      'const canSubmit = validation.ok && expected.ok && !submitting && !loading && !namesFailed && pickersError === null;',
    );
    expect(code).toContain(
      '<Display size={24} style={{ marginTop: 10 }} accessibilityRole="header"> Create the PO </Display>',
    );
  });

  // Mutation caught: the date box back to a fixed 46pt height (the typed date
  // clipped at the larger sizes), unnamed again (VoiceOver read only the
  // example date), or its words lost.
  it('the expected date box is named, grows with the text and keeps its rule and words', () => {
    const code = flatCode(REVIEW);
    expect(code).toContain("const EXPECTED_DATE_LABEL = 'EXPECTED DATE (OPTIONAL · YYYY-MM-DD)';");
    expect(code).toContain('<FieldLabel>{EXPECTED_DATE_LABEL}</FieldLabel>');
    expect(code).toContain('accessibilityLabel={EXPECTED_DATE_LABEL}');
    expect(code).toContain('placeholder="2026-08-01" placeholderTextColor={c.ink3}');
    expect(code).toContain('keyboardType="numbers-and-punctuation"');
    expect(code).toContain('minHeight: 46,');
    expect(code).not.toMatch(/\bheight: 46\b/);
    expect(code).toContain(
      'borderColor: !expected.ok ? c.critText : dateFocused ? c.ink : c.hair2,',
    );
    expect(code).toContain('backgroundColor: c.card,');
    expect(code).toContain(
      '{!expected.ok ? ( <Mono size={11} color={c.critText}> Use YYYY-MM-DD (or leave blank). </Mono> ) : null}',
    );
    expect(code).toContain('const expected = normalizeExpectedAt(expectedAtText);');
  });

  it("the sheet's fields, choices and notes survive, word for word", () => {
    const code = flatCode(REVIEW);
    for (const words of [
      '<Eyebrow>APPROVE IMPORT</Eyebrow>',
      '<FieldLabel>WAREHOUSE *</FieldLabel>',
      'No warehouses — create one on the web first.',
      '<Chip key={w.id} label={w.name} active={w.id === warehouseId} onPress={() => pickWarehouse(w.id)} />',
      '<FieldLabel>VENDOR *</FieldLabel>',
      'No suppliers yet — add the vendor on the web first.',
      '<Chip key={v.id} label={v.name} active={v.id === vendorId} onPress={() => setVendorId(v.id)} />',
      '<FieldLabel>RECEIVE INTO (SITE) *</FieldLabel>',
      'Pick a warehouse first.',
      'No site locations in this warehouse — add one on the web first.',
      '<Chip key={l.id} label={l.name} active={l.id === locationId} onPress={() => setLocationId(l.id)} />',
      '<FieldLabel>CHARTER FOR ITEMS (OWNERSHIP)</FieldLabel>',
      'Who owns the stock. &quot;Keep as-is&quot; changes no item&apos;s charter.',
      'No charters configured — items stay generic.',
      '<Chip label="Keep as-is" active={itemCharterId === undefined} onPress={() => setItemCharterId(undefined)} />',
      '<Chip label="Generic" active={itemCharterId === null} onPress={() => setItemCharterId(null)} />',
      '<Chip key={ch.id} label={ch.name} active={ch.id === itemCharterId} onPress={() => setItemCharterId(ch.id)} />',
      '<FieldLabel>BILL-TO CHARTER (BILLING ONLY)</FieldLabel>',
      'Printed on the PO document. Does not affect the warehouse, the destination location, item ownership or access.',
      'No charters configured — the PO stays generic.',
      '<Chip label="Generic" active={billToCharterId === null} onPress={() => setBillToCharterId(null)} />',
      '<Chip key={ch.id} label={ch.name} active={ch.id === billToCharterId} onPress={() => setBillToCharterId(ch.id)} />',
      '<FieldLabel>UNMATCHED LINES *</FieldLabel>',
      'Decide each line: link an existing item, create a new one, or skip it.',
      "label={`Use · ${cand.name}${cand.sku ? ` (${cand.sku})` : ''}`}",
      '<Chip label="Create new" active={d?.mode === \'create\'}',
      '<Chip label="Skip" active={d?.mode === \'skip\'}',
      '{l.description?.trim() || `Line ${l.line_number}`}',
      'Could not load the vendor, charter and location choices.',
      'Close this sheet and open it again to try again.',
      '{validation.reason}',
      "? `Suggestions unavailable — ${e.message}` : 'Suggestions unavailable.',",
      "setError(e instanceof Error ? e.message : 'Could not approve this import.');",
    ]) {
      expect(code).toContain(words);
    }
  });

  // Mutation caught: ownership and billing merged again, or the create and
  // approve calls reordered, unguarded or reshaped.
  it('creates the new items first, then approves with the two charters apart, once per tap', () => {
    const code = flatCode(REVIEW);
    expect(code).toContain(
      'if (!canSubmit || !validation.ok || !expected.ok) return; if (submittingRef.current) return; submittingRef.current = true; setSubmitting(true); setError(null);',
    );
    expect(code).toContain(
      'const toCreate = createLineIds(decisions); if (toCreate.length > 0) { await createItemsFromLines(importId, { lineIds: toCreate, vendorId: vendorId!, warehouseId, charterId: ownershipCharterForCreate(charterDraft), locationId: locationId ?? null, }); }',
    );
    expect(code).toContain(
      'const { poId } = await approvePoImport(importId, { warehouseId: warehouseId!, vendorId: vendorId!, locationId: locationId!, ...buildApproveCharterFields(charterDraft), expectedAt: expected.value, lineOverrides: buildLineOverrides(decisions), }); onApproved(poId);',
    );
    expect(code).toContain('} finally { setSubmitting(false); submittingRef.current = false; }');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scan a PO
// ─────────────────────────────────────────────────────────────────────────────

describe('Scan a PO follows the device, on the per-mode palette', () => {
  const code = codeOnly(sourceOf(SCAN));

  it('off the light-only legacy alias and the single-mode accents; fixed colours only for the camera', () => {
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    expect(code).not.toMatch(/\btheme\./);
    expect(code).not.toMatch(/import \{[^}]*\btheme\b[^}]*\} from '@\/lib\/theme'/);
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/fontWeight: '7/);
    expect(code).not.toMatch(/\bc\.(ink4|ink5|paper2)\b/);
    // The viewfinder's ground, the shutter's white and the scrim behind the
    // words on a captured page: the camera's own colours, the same in both modes.
    expect((code.match(/['"`]#[0-9a-f]{3,8}['"`]/gi) ?? []).sort()).toEqual([
      "'#0a0b09'",
      "'#ffffff'",
    ]);
    expect(code.match(/rgba\([^)]*\)/g) ?? []).toEqual(['rgba(10, 11, 9, 0.72)']);
  });

  it('its styles are built once per mode and picked by the device mode', () => {
    const flat = flatCode(SCAN);
    expect(flat).toContain(
      "const SCAN_PO_STYLES: Record<ThemeMode, ReturnType<typeof makeStyles>> = { light: makeStyles(palette('light')), dark: makeStyles(palette('dark')), };",
    );
    expect(flat).toContain('const styles = SCAN_PO_STYLES[themeMode];');
  });

  // Mutation caught: a sparkle or other emoji put back in the words.
  it('no emoji in its words: the sparkle became an icon beside "Extract"', () => {
    expect(wordsOf(SCAN).filter((w) => /\p{Extended_Pictographic}/u.test(w))).toEqual([]);
    expect(flatCode(SCAN)).toContain(
      "import { ChevronLeft, Sparkles } from 'lucide-react-native';",
    );
  });

  it.each(MODES)('%s: every word reads at AA on what it sits on', (_m, c) => {
    const { makeStyles } = topLevel(SCAN, [
      'CAMERA_PALETTE',
      'CAMERA',
      'PHOTO_SCRIM',
      'makeStyles',
    ]) as {
      makeStyles: (p: Palette) => Styles;
    };
    const s = makeStyles(c);
    const page = colour(s, 'root', 'backgroundColor');
    expect(page).toBe(c.paper);
    const pairs: [string, string, string][] = [
      ['title (Display ink)', c.ink, page],
      ['subtitle (Body muted)', c.ink3, page],
      ['nameLabel', colour(s, 'nameLabel'), page],
      ['nameHint', colour(s, 'nameHint'), page],
      ['nameInput', colour(s, 'nameInput'), colour(s, 'nameInput', 'backgroundColor')],
      ['placeholder', c.ink3, colour(s, 'nameInput', 'backgroundColor')],
      ['modeQuestion', colour(s, 'modeQuestion'), colour(s, 'modeCard', 'backgroundColor')],
      ['modeBtnTitle', colour(s, 'modeBtnTitle'), colour(s, 'modeCard', 'backgroundColor')],
      ['modeBtnSub', colour(s, 'modeBtnSub'), colour(s, 'modeCard', 'backgroundColor')],
      [
        'modeBtnTitle (chosen)',
        colour(s, 'modeBtnTitle'),
        colour(s, 'modeBtnActive', 'backgroundColor'),
      ],
      [
        'modeBtnSub (chosen)',
        colour(s, 'modeBtnSub'),
        colour(s, 'modeBtnActive', 'backgroundColor'),
      ],
      ['progressLabel', colour(s, 'progressLabel'), colour(s, 'progressCard', 'backgroundColor')],
      ['progressHint', colour(s, 'progressHint'), colour(s, 'progressCard', 'backgroundColor')],
    ];
    for (const [name, fg, bg] of pairs) {
      expect(contrast(fg, bg), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // The chosen mode's edge, the name box's focused edge and the progress
    // fill on its track stand out (UI parts).
    expect(
      contrast(colour(s, 'modeBtnActive', 'borderColor'), colour(s, 'modeCard', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_UI);
    expect(
      contrast(
        colour(s, 'nameInputFocused', 'borderColor'),
        colour(s, 'nameInput', 'backgroundColor'),
      ),
    ).toBeGreaterThanOrEqual(AA_UI);
    expect(
      contrast(
        colour(s, 'progressFill', 'backgroundColor'),
        colour(s, 'progressTrack', 'backgroundColor'),
      ),
    ).toBeGreaterThanOrEqual(AA_UI);
    // "Hold to remove" over a captured page: the camera scrim over a white
    // page and over a black one, the same in both modes.
    const scrim = colour(s, 'thumbnailOverlay', 'backgroundColor');
    for (const photo of ['#ffffff', '#000000']) {
      expect(
        contrast(colour(s, 'thumbnailHint'), over(scrim, photo)),
        photo,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('the camera chrome is dark in both modes', () => {
  const cam = topLevel(SCAN, ['CAMERA_PALETTE', 'CAMERA', 'CLOSE_CAP', 'cameraStyles']) as {
    CAMERA: Record<string, string>;
    CLOSE_CAP: number;
    cameraStyles: Styles;
  };
  const code = flatCode(SCAN);

  it('draws the bar and the ground from the dark palette, never the device mode', () => {
    const dark = palette('dark');
    expect(cam.CAMERA).toEqual({
      surface: '#0a0b09',
      ink: dark.ink,
      ink2: dark.ink2,
      chip: dark.card,
      chipBorder: dark.ink4,
      shutter: '#ffffff',
      shutterRing: dark.ink4,
    });
    const camera = code.slice(
      code.indexOf('if (cameraOpen) {'),
      code.indexOf('return ( <SafeAreaView style={styles.root}'),
    );
    expect(camera.length).toBeGreaterThan(0);
    expect(camera).not.toMatch(/\bstyles\./);
    expect(camera).not.toMatch(/\bc\./);
  });

  // Mutation caught: the root's dark clock left over the black camera ground
  // in light mode.
  it('the clock and battery are light while the camera is up', () => {
    expect(code).toContain("import { StatusBar } from 'expo-status-bar';");
    expect(code).toContain(
      'if (cameraOpen) { return ( <View style={cameraStyles.root}> <StatusBar style="light" />',
    );
  });

  it('Done is a named button in a 44pt frame on the bar, capped at the chrome ceiling; the tally keeps its words', () => {
    expect(code).toMatch(
      /<Pressable onPress=\{\(\) => setCameraOpen\(false\)\} accessibilityRole="button" accessibilityLabel="Done" style=\{\(\{ pressed \}\) => \[cameraStyles\.closeFrame, pressed && \{ opacity: 0\.7 \}\]\} > <View style=\{cameraStyles\.closeBtn\}> <Text style=\{cameraStyles\.closeText\} numberOfLines=\{1\} maxFontSizeMultiplier=\{CLOSE_CAP\} > Done <\/Text>/,
    );
    expect(cam.CLOSE_CAP).toBe(capTo(13, TYPE_CEILING.chrome));
    expect(cam.cameraStyles.closeFrame).toMatchObject({ minHeight: 44, minWidth: 44 });
    expect(code).toContain(
      '<Text style={cameraStyles.frameCount}> {frames.length}/{MAX_FRAMES} captured </Text>',
    );
  });

  // Mutation caught: the shutter unnamed again (VoiceOver read nothing).
  it('the shutter is a button named "Take photo", 72pt, that takes the photo', () => {
    expect(code).toMatch(
      /<Pressable onPress=\{captureFrame\} accessibilityRole="button" accessibilityLabel="Take photo" style=\{\(\{ pressed \}\) => \[ cameraStyles\.shutter, pressed && \{ transform: \[\{ scale: 0\.92 \}\] \}, \]\} \/>/,
    );
    expect(cam.cameraStyles.shutter).toMatchObject({ width: 72, height: 72 });
    expect(code).toContain(
      '<CameraView ref={cameraRef} style={cameraStyles.camera} facing="back" />',
    );
  });

  it('Done, the tally and the shutter stand out from the bar', () => {
    const s = cam.cameraStyles;
    expect(
      contrast(colour(s, 'closeText'), colour(s, 'closeBtn', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(
      contrast(colour(s, 'frameCount'), colour(s, 'bar', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(
      contrast(colour(s, 'closeBtn', 'borderColor'), colour(s, 'bar', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_UI);
    expect(
      contrast(colour(s, 'shutter', 'backgroundColor'), colour(s, 'shutterBar', 'backgroundColor')),
    ).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('Scan a PO: never more than five pages, one photo and one extraction at a time', () => {
  const code = flatCode(SCAN);
  const { appendFrames, MAX_FRAMES } = topLevel(SCAN, ['MAX_FRAMES', 'appendFrames']) as {
    appendFrames: <T>(cur: T[], incoming: T[], max: number) => T[];
    MAX_FRAMES: number;
  };

  // Mutation caught: a capture past the limit kept (the scan route refuses a
  // request of more than five files, after the whole upload).
  it('appendFrames keeps only as many new pages as fit, in order', () => {
    expect(MAX_FRAMES).toBe(5);
    expect(appendFrames([1, 2], [3, 4], 5)).toEqual([1, 2, 3, 4]);
    expect(appendFrames([1, 2, 3, 4], [5, 6, 7], 5)).toEqual([1, 2, 3, 4, 5]);
    expect(appendFrames([1, 2, 3, 4, 5], [6], 5)).toEqual([1, 2, 3, 4, 5]);
    expect(appendFrames([1, 2, 3, 4, 5, 6], [7], 5)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(appendFrames([], [], 5)).toEqual([]);
  });

  it('every source of pages goes through it', () => {
    expect(code.match(/setFrames\(\(cur\) => appendFrames\(/g) ?? []).toHaveLength(3);
    expect(code).not.toMatch(/setFrames\(\(cur\) => \[ \.\.\.cur/);
  });

  // Mutation caught: a second tap on the shutter while the first photo was
  // still being taken (it read the old count and passed the limit check), or
  // a failed capture escaping as an unhandled rejection.
  it('one photo at a time, and a capture the camera could not take is not thrown away loudly', () => {
    expect(code).toContain('const capturingRef = React.useRef(false);');
    expect(code).toContain(
      "if (frames.length >= MAX_FRAMES) { Alert.alert('Limit reached', `Up to ${MAX_FRAMES} frames per scan.`); return; } if (capturingRef.current) return; capturingRef.current = true; try { const photo = await cameraRef.current.takePictureAsync({ quality: 0.85, base64: false, });",
    );
    expect(code).toContain(
      "} catch (e) { console.warn('[scan-po] capture failed', e instanceof Error ? e.message : e); } finally { capturingRef.current = false; }",
    );
  });

  // Mutation caught: the library offered with no slot left (the picker reads
  // a limit of 0 as no limit at all).
  it('with every slot taken the library is not offered; otherwise it offers the slots left', () => {
    expect(code).toContain(
      "async function pickFromLibrary() { if (frames.length >= MAX_FRAMES) { Alert.alert('Limit reached', `Up to ${MAX_FRAMES} frames per scan.`); return; } const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: true, selectionLimit: MAX_FRAMES - frames.length, quality: 0.85, });",
    );
  });

  // Mutation caught: a quick second tap on Extract sending the same pages
  // twice (two extractions).
  it('Extract runs once per tap: a synchronous guard after the two early answers, cleared at the end', () => {
    expect(code).toContain(
      "if (frames.length === 0) { Alert.alert('Nothing to scan', 'Take at least one photo first.'); return; } if (!session) { Alert.alert('Not signed in', 'Sign in again and retry.'); return; } if (submittingRef.current) return; submittingRef.current = true; setBusy(true);",
    );
    expect(code).toContain(
      '} finally { stopProgress(); setBusy(false); submittingRef.current = false; }',
    );
  });

  // Mutation caught: completion said before the server answered.
  it('the progress says Done only once the server has answered with an import', () => {
    const answered = code.indexOf('if (!res.ok || !json.ok) {');
    const done = code.indexOf("setStageLabel('Done');");
    expect(answered).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(answered);
    expect(code).toContain(
      "const STAGES = [ 'Uploading photos…', 'Reading the document…', 'Extracting vendor & line items…', 'Finishing up…', ];",
    );
    expect(code).toContain('Animated.timing(progressAnim, { toValue: 0.92, duration: 13000,');
    expect(code).toContain("<Text style={styles.progressLabel}>{stageLabel || 'Working…'}</Text>");
  });
});

describe('Scan a PO: its controls have roles, names and 44pt targets', () => {
  const code = flatCode(SCAN);

  // Mutation caught: the buttons back side by side ("From library" and "Take
  // photo" lost their words), or a second ink or accent button.
  it('Scan document leads (accent), Take photo and From library are outlined; Extract is the one ink button', () => {
    expect(code).toContain(
      '<View style={styles.actions}> <Button variant="accent" block onPress={scanCleanDocument}> Scan document </Button> <Button variant="outline" block onPress={openCamera}> Take photo </Button> <Button variant="outline" block onPress={pickFromLibrary}> From library </Button> </View>',
    );
    const { sf, nodes } = nodesOf(SCAN, 'ScanPo');
    const buttons = nodes.filter((n) => tagOf(n.el, sf) === 'Button');
    const ink = buttons.filter((n) => attrText(n.el, 'variant', sf) === undefined);
    expect(ink).toHaveLength(1);
    expect(textOf(ink[0]!.el, sf)).toContain('Extract');
    expect(buttons.filter((n) => attrText(n.el, 'variant', sf) === 'accent')).toHaveLength(1);
    expect(code).toContain(
      "{frames.length > 0 && !busy && ( <Button block onPress={submit} style={styles.extractBtn} leading={<Sparkles size={16} color={c.paper} strokeWidth={1.75} />} > Extract {frames.length}{' '} {frames.length > 1 && separate ? 'POs' : frames.length === 1 ? 'page' : 'pages'} </Button> )}",
    );
  });

  // Mutation caught: the two choices back to unnamed elements with no state.
  it('the two modes are radio buttons in a group, the chosen one checked', () => {
    expect(code).toContain(
      '<View style={styles.modeRow} accessibilityRole="radiogroup"> <Pressable onPress={() => setSeparate(true)} accessibilityRole="radio" accessibilityState={{ checked: separate }} style={[styles.modeBtn, separate && styles.modeBtnActive]} > <Text style={styles.modeBtnTitle}>Separate POs</Text> <Text style={styles.modeBtnSub}>Each becomes its own import</Text> </Pressable> <Pressable onPress={() => setSeparate(false)} accessibilityRole="radio" accessibilityState={{ checked: !separate }} style={[styles.modeBtn, !separate && styles.modeBtnActive]} > <Text style={styles.modeBtnTitle}>One multi-page PO</Text> <Text style={styles.modeBtnSub}>Combine as pages of one PO</Text> </Pressable> </View>',
    );
    expect(code).toContain('{frames.length > 1 && !busy && (');
    expect(code).toContain(
      '<Text style={styles.modeQuestion}>{frames.length} captures — are these…</Text>',
    );
  });

  // Mutation caught: a page that only a sighted hold could remove.
  it('each captured page is removed by a hold, or by the Remove action VoiceOver offers', () => {
    expect(code).toContain("const REMOVE_PAGE_ACTIONS = [{ name: 'remove', label: 'Remove' }];");
    const holds = code.match(
      /onLongPress=\{\(\) => removeFrame\(f\.uri\)\} accessibilityActions=\{REMOVE_PAGE_ACTIONS\} onAccessibilityAction=\{\(e\) => \{ if \(e\.nativeEvent\.actionName === 'remove'\) removeFrame\(f\.uri\); \}\}/g,
    );
    expect(holds ?? []).toHaveLength(2);
  });

  // Mutation caught: the hint uncapped again ("Hold" broke mid-word in the
  // 56pt frame at the larger accessibility sizes), or its words changed.
  it("the hint on a page keeps its words, capped at the chrome ceiling inside the page's frame", () => {
    expect(code).toContain(
      '<Text style={styles.thumbnailHint} maxFontSizeMultiplier={HINT_CAP}> Hold to remove </Text>',
    );
    expect(code).toContain(
      '<Text style={styles.thumbnailHint} maxFontSizeMultiplier={HINT_CAP}> Hold </Text>',
    );
    const { HINT_CAP } = topLevel(SCAN, ['HINT_CAP']) as { HINT_CAP: number };
    expect(HINT_CAP).toBe(capTo(10.5, TYPE_CEILING.chrome));
    // The cap is a ceiling in points: 20pt at most, which "Hold" fits in 56pt.
    expect(10.5 * HINT_CAP).toBe(TYPE_CEILING.chrome);
  });

  it('each name box is named for VoiceOver, its hint muted ink, and it grows with the text', () => {
    expect(code).toContain('accessibilityLabel="PO name"');
    expect(code).toContain('accessibilityLabel={`PO ${i + 1} name`}');
    expect(code.match(/placeholderTextColor=\{c\.ink3\}/g) ?? []).toHaveLength(2);
    expect(code.match(/maxLength=\{PO_IMPORT_DISPLAY_NAME_MAX\}/g) ?? []).toHaveLength(2);
    expect(code.match(/editable=\{!busy\}/g) ?? []).toHaveLength(2);
    const { makeStyles } = topLevel(SCAN, [
      'CAMERA_PALETTE',
      'CAMERA',
      'PHOTO_SCRIM',
      'makeStyles',
    ]) as {
      makeStyles: (p: Palette) => Styles;
    };
    const s = makeStyles(palette('light'));
    expect(s.nameInput).toMatchObject({ minHeight: 44 });
    expect(s.nameInput?.height).toBeUndefined();
    expect(s.modeBtn).toMatchObject({ minHeight: 44 });
    // A name box low on the page scrolls clear of the keyboard.
    expect(code).toContain(
      '<ScrollView contentContainerStyle={{ padding: SPACE.md, paddingBottom: 200 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets >',
    );
  });

  it('every word on the screen survives, word for word', () => {
    for (const words of [
      '<Display size={28} accessibilityRole="header"> Scan a PO </Display>',
      'Take a photo of a printed purchase order. Up to {MAX_FRAMES} pages — we extract vendor, line items, and totals automatically, then you review and approve right here.',
      '<Text style={styles.nameLabel}>PO name</Text>',
      'placeholder="Example: August DC4 Book Order"',
      'Optional — without one it is listed by its file name.',
      '<Text style={styles.nameLabel}>PO {i + 1} name</Text>',
      'Names are optional. Hold a photo to remove it.',
      'Extracting with AI — this usually takes a few seconds. Keep the app open.',
      "Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan POs.');",
      "'Scanner unavailable', 'Document scanning needs the latest app build. Use Take photo instead.',",
      "'Could not prepare the photos', 'None of the captured pages could be processed for upload. Retake them and try again.',",
      "'Too many scans in a short window. Wait about a minute and try again.'",
      '`Scan failed (HTTP ${res.status}). Please try again.`',
      "Alert.alert('Scan failed', msg);",
      "'Imported',",
      '. Review and approve each.`,',
      "{ text: 'Review', onPress: () => router.replace('/po-imports') },",
      "{ text: 'Later', style: 'cancel' },",
      "'Extracted',",
      "'Looks clean. Review and approve the import.'",
      "text: 'Review now', onPress: () => router.replace({ pathname: '/po-import/[id]', params: { id: importId } }),",
      "text: 'Open in browser', onPress: () => Linking.openURL(reviewUrl),",
      "'The scan timed out. Check your connection and try again.'",
      'accessibilityLabel="Back"',
    ]) {
      expect(code).toContain(words);
    }
  });

  it('the scan still posts the same multipart request to the same route', () => {
    expect(code).toContain('res = await postMultipart(`${API_BASE}/api/po-imports/scan`, {');
    expect(code).toContain("const mode = frames.length > 1 && separate ? 'separate' : 'combined';");
    expect(code).toContain('const displayNames = buildDisplayNames({ names, sentIndices, mode });');
    expect(code).toContain(
      "fileParts.push({ field: 'file', uri, fileName: name, contentType: type });",
    );
    expect(code).toContain('const timeout = setTimeout(() => ctrl.abort(), 70_000);');
  });
});
