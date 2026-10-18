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
import { palette, type Palette } from './theme';

/**
 * THE PURCHASING LISTS, READ AS SOURCE (redesign package P5.8).
 *
 * The Receive POs tab, the Purchase orders list, Import history, Recurring POs
 * and Suppliers (the last three also the optional bottom tabs) took the
 * redesign's look on the per-mode palette: informational words in muted ink3
 * or stronger, the per-mode warning and refusal tones, recessed wells on
 * cards, the MintWash glow gone. These pin what had to survive it and what
 * the package fixed:
 *
 *   - every word, eyebrow and empty sentence, word for word;
 *   - a failed read is said in its own words, never as "Nothing to receive."
 *     or "No POs yet." (CONFLICTS D25, D27): a failed refresh keeps the rows
 *     and says so above them, a workspace switch never shows another
 *     workspace's rows, and with no workspace a pull loads it again (each
 *     screen's own settleList is run below);
 *   - the Receive tab's sort label says how its rows are ordered, and its
 *     card no longer draws a partial-receipt bar fixed at 47% (D27);
 *   - rows that open something are buttons to VoiceOver, the header pills and
 *     the supplier links are real 44pt frames, a recurring PO's switch says
 *     which template it pauses, and Delete template is the refusal-red words.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, as storage-lists-structure.test.ts reads its lists,
 * and the colours each screen names are measured with the palette they come
 * from.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const RECEIVE = 'app/(drawer)/(tabs)/receive.tsx';
const PO_LIST = 'src/screens/purchase-orders.tsx';
const IMPORTS = 'src/screens/po-imports.tsx';
const RECURRING = 'app/(drawer)/recurring-pos.tsx';
const SUPPLIERS = 'src/screens/suppliers.tsx';
const FILES = [RECEIVE, PO_LIST, IMPORTS, RECURRING, SUPPLIERS];

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
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The same, with every run of whitespace made one space. */
function flatCode(file: string): string {
  return codeOnly(sourceOf(file)).replace(/\s+/g, ' ');
}

/** Every element of a file that matches, with the tree it came from. */
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

/**
 * A top-level function of a screen, compiled from the repository's own
 * source (never from input) and run in an empty context: the pure helpers
 * whose answers are the behaviour.
 */
function screenFunction(file: string, name: string): (...args: unknown[]) => unknown {
  const sf = treeOf(file);
  const fn = sf.statements.find(
    (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name,
  );
  expect(fn, `${name} in ${file}`).toBeDefined();
  const js = ts.transpileModule(`${fn!.getText(sf)}\n${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({}) as (...args: unknown[]) => unknown;
}

describe('the per-mode palette on every list of the package', () => {
  it.each(FILES)('%s: no fixed colours, no single-mode accents, no legacy theme', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    // ACCENT's mint, warn and crit are under AA as words in one mode or the
    // other (the Receive pip and its "Set destination" line used them).
    expect(code).not.toMatch(/\bACCENT\b/);
    // The light-only legacy alias.
    expect(code).not.toMatch(/\btheme\./);
    // No hard-coded colour for words, fills or borders (Delete template was
    // the fixed red #b91c1c, 3.6:1 on the dark card).
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    expect(code).not.toMatch(/rgba?\(/);
    // paper2 is the card colour in dark (a well on a card drew nothing); ink5
    // is decoration only.
    expect(code).not.toMatch(/\bc\.(paper2|ink5)\b/);
  });

  // Mutation caught: any word put back in c.ink4 (a supplier line, a PO's
  // ETA, an import's vendor and date, a template's cadence line, a stat label).
  it.each(FILES)('%s: the faint ink4 never colours words', (file) => {
    expect(codeOnly(sourceOf(file))).not.toMatch(/\bc\.ink4\b/);
  });

  it('MintWash is gone from the Receive tab: it paints nothing now', () => {
    const code = codeOnly(sourceOf(RECEIVE));
    expect(code).not.toContain('MintWash');
    expect(code).not.toContain('mint-wash');
    expect(code).not.toContain('washPos');
  });

  it("the Receive tab's camera sits in a recessed well, its pip in the per-mode accent", () => {
    const code = flatCode(RECEIVE);
    expect(code).toContain(
      '<View style={[styles.cameraWell, { backgroundColor: c.sunk, borderColor: c.hair }]}>',
    );
    expect(code).toContain('<View style={[styles.mintPip, { backgroundColor: c.accent }]} />');
  });

  it('the supplier well is recessed too (sunk, never the card colour)', () => {
    expect(flatCode(SUPPLIERS)).toContain(
      '<View style={[styles.well, { borderColor: c.hair, backgroundColor: c.sunk }]}>',
    );
  });
});

/** Each list's words for a read that failed, a refresh that failed, and none. */
const LISTS = [
  {
    file: PO_LIST,
    noun: 'purchase orders',
    orgVar: 'orgId',
    rowType: 'PORow',
    tag: 'purchase-orders',
    eyebrow:
      "list === null || failedEmpty ? 'PROCUREMENT · POs' : `PROCUREMENT · ${rows.length} POs`",
    empty: [
      'emptyTitle="No POs yet."',
      'emptyBody="Create purchase orders on the web; the open ones show on the POs tab for receiving."',
    ],
  },
  {
    file: IMPORTS,
    noun: 'imports',
    orgVar: 'orgId',
    rowType: 'ImportRow',
    tag: 'po-imports',
    eyebrow: 'eyebrow="PROCUREMENT · PO IMPORTS"',
    empty: [
      'emptyTitle="No imports yet."',
      "canManage ? 'Scan a packing slip or PO with the Scan button above — the parsed import lands here for review and approval.' : 'Scanned POs land here once someone with purchase-order access imports one.'",
    ],
  },
  {
    file: RECURRING,
    noun: 'recurring POs',
    orgVar: 'activeOrgId',
    rowType: 'TemplateRow',
    tag: 'recurring-pos',
    eyebrow:
      "list === null || failedEmpty ? 'AUTOMATION' : `AUTOMATION · ${rows.filter((r) => r.enabled).length} ACTIVE`",
    empty: [
      'emptyTitle="No recurring POs yet."',
      'emptyBody="Create one on the web dashboard from any purchase order (“Make recurring”) — it will generate POs on schedule and show up here."',
    ],
  },
  {
    file: SUPPLIERS,
    noun: 'suppliers',
    orgVar: 'orgId',
    rowType: 'SupplierRow',
    tag: 'suppliers',
    eyebrow:
      "list === null || failedEmpty ? 'DIRECTORY · SUPPLIERS' : `DIRECTORY · ${rows.length} SUPPLIERS`",
    empty: [
      'emptyTitle="No suppliers yet."',
      'emptyBody="Add vendors on the web to attach them to purchase orders here."',
    ],
  },
] as const;

/** The rule every list (and the Receive tab) settles its reads by. */
function expectSettleRule(file: string) {
  const settle = screenFunction(file, 'settleList');
  const a = [{ id: 'a1' }];
  const read = settle(null, 'org-a', a);
  expect(read).toEqual({ orgId: 'org-a', rows: a, failed: false });
  // The first read failed: the failure, with no rows.
  expect(settle(null, 'org-a', null)).toEqual({ orgId: 'org-a', rows: [], failed: true });
  // A refresh failed: the rows already shown stay, marked failed.
  expect(settle(read, 'org-a', null)).toEqual({ orgId: 'org-a', rows: a, failed: true });
  // A switch to another workspace whose read failed: never org-a's rows.
  expect(settle(read, 'org-b', null)).toEqual({ orgId: 'org-b', rows: [], failed: true });
  // A good read after a failed one clears the failure; an empty good read is
  // the empty list, not a failure.
  const b = [{ id: 'a2' }];
  expect(settle(settle(read, 'org-a', null), 'org-a', b)).toEqual({
    orgId: 'org-a',
    rows: b,
    failed: false,
  });
  expect(settle(read, 'org-a', [])).toEqual({ orgId: 'org-a', rows: [], failed: false });
}

describe('D25: a failed read on a drawer list is said, never shown as an empty list', () => {
  describe.each(LISTS)('$file', ({ file, noun, orgVar, rowType, tag, eyebrow, empty }) => {
    const code = flatCode(file);

    // Mutation caught: the screen's old `setRows(data ?? [])` (an error read
    // as no rows), and any branch of the rule changed.
    it("its own settleList: a failed read keeps this workspace's rows, never another's", () => {
      expectSettleRule(file);
    });

    it('a failed read lands through settleList, after the newest-read check', () => {
      expect(code).toContain('if (error) throw new Error(error.message);');
      expect(code).toContain(
        `const seq = ++seqRef.current; let rows: ${rowType}[] | null = null; try {`,
      );
      // Only the message is logged, never the whole PostgREST error object.
      expect(code).toContain(
        `} catch (e) { console.warn('[${tag}] load failed:', e instanceof Error ? e.message : e); } if (seq !== seqRef.current) return; setStored((prev) => settleList(prev, ${orgVar}, rows));`,
      );
      // Only the workspace on screen.
      expect(code).toContain(`const list = stored && stored.orgId === ${orgVar} ? stored : null;`);
      expect(code).toContain(`const noWorkspace = !${orgVar} && !workspaceLoading;`);
    });

    // Mutation caught: failed left off (the empty words over a failure), the
    // words swapped into emptyTitle, the workspace case dropped, or a pull
    // that cannot load a missing workspace again.
    it('passes DataListScreen its own failure words; the empty words are only the empty words', () => {
      expect(code).toContain(
        `failed={ noWorkspace ? { title: 'Could not load your workspace.', body: 'Check your connection and pull down to try again.', } : list?.failed ? { title: 'Could not load ${noun}.', body: 'Check your connection and pull down to try again.', reloadNote: 'Could not refresh the ${noun}. Pull down to try again.', } : null }`,
      );
      for (const words of empty) expect(code).toContain(words);
      expect(code).not.toMatch(/emptyTitle=\{[^}]*Could not/);
      expect(code).toContain('loading={!noWorkspace && list === null}');
      expect(code).toContain('await (noWorkspace ? retryWorkspace() : load());');
      expect(code).toContain('onRefresh={() => void refresh()}');
    });

    // Mutation caught: "0 POs" (or 0 ACTIVE, 0 SUPPLIERS) said over a read
    // that failed or has not answered.
    it('the eyebrow counts only rows a read returned', () => {
      expect(code).toContain(eyebrow);
    });
  });
});

describe('D27: the Receive tab', () => {
  const code = flatCode(RECEIVE);

  it("its own settleList: a failed read keeps this workspace's purchase orders, never another's", () => {
    expectSettleRule(RECEIVE);
  });

  it('a failed read lands through settleList, after the newest-read check', () => {
    expect(code).toContain('const seq = ++seqRef.current; let rows: OpenPo[] | null = null; try {');
    expect(code).toContain('if (error) throw new Error(error.message);');
    expect(code).toContain(
      "} catch (e) { console.warn('[receive] load failed:', e instanceof Error ? e.message : e); } if (seq !== seqRef.current) return; setStored((prev) => settleList(prev, orgId, rows));",
    );
    expect(code).toContain('const list = stored && stored.orgId === orgId ? stored : null;');
    expect(code).toContain('const pos = React.useMemo(() => list?.rows ?? [], [list]);');
    // The old failure path emptied the list into "Nothing to receive.".
    expect(code).not.toContain('setPos([])');
  });

  // Mutation caught: the failure said as "Nothing to receive." again.
  it('a failed read says so in its own words, with the warning glyph; the empty words stay for an empty list', () => {
    expect(code).toContain(
      "const failure: DataListFailure | null = noWorkspace ? { title: 'Could not load your workspace.', body: 'Check your connection and pull down to try again.', } : list?.failed ? { title: 'Could not load purchase orders.', body: 'Check your connection and pull down to try again.', reloadNote: 'Could not refresh the purchase orders. Pull down to try again.', } : null;",
    );
    expect(code).toMatch(
      /ListEmptyComponent=\{ failure \? \( <View style=\{styles\.empty\}> <View style=\{\{ marginBottom: 12 \}\}> <TriangleAlert size=\{32\} color=\{c\.warnText\} strokeWidth=\{1\.3\} \/> <\/View> <Display size=\{18\} accessibilityRole="alert" style=\{\{ textAlign: 'center' \}\}> \{failure\.title\} <\/Display> <Body muted style=\{\{ marginTop: 6, textAlign: 'center', maxWidth: 320 \}\}> \{failure\.body\} <\/Body> <\/View> \) : \( <View style=\{styles\.empty\}> <Display size=\{18\}>Nothing to receive\.<\/Display>/,
    );
    expect(code).toContain(
      'When a PO is approved on the web, it&apos;ll appear here ready to scan and receive.',
    );
  });

  it('a refresh that failed keeps the purchase orders and says so above them, on the warning wash', () => {
    expect(code).toContain('const reloadNote = dataListReloadNote(failure, pos.length);');
    expect(code).toMatch(
      /ListHeaderComponent=\{ reloadNote \? \( <View style=\{\[styles\.reloadNote, \{ backgroundColor: c\.warnWash \}\]\}> <TriangleAlert size=\{16\} color=\{c\.warnText\}[^>]*\/> <Body size=\{13\.5\} color=\{c\.warnText\} accessibilityRole="alert" style=\{\{ flex: 1 \}\}> \{reloadNote\} <\/Body> <\/View> \) : undefined \}/,
    );
  });

  it('with no workspace a pull loads it again; a spinner only while a read is out or none has answered', () => {
    expect(code).toContain('const noWorkspace = !orgId && !workspaceLoading;');
    expect(code).toContain('await (noWorkspace ? retryWorkspace() : load());');
    expect(code).toContain('{loading || (!noWorkspace && list === null) ? (');
    // Still a spinner while each focus re-reads, as before.
    expect(code).toContain('setLoading(true); await load(); if (!cancelled) setLoading(false);');
  });

  // Mutation caught: "0 OPEN" said before the first read answers or over a
  // read that failed; or the placeholder line read aloud.
  it('the open count is said only once a read answered; until then its line is held, silent', () => {
    expect(code).toContain(
      'const countKnown = list !== null && !(list.failed && pos.length === 0);',
    );
    expect(code).toContain(
      '{countKnown ? ( <Eyebrow>{`${pos.length} OPEN${overdueCount > 0 ? ` · ${overdueCount} OVERDUE` : \'\'}`}</Eyebrow> ) : ( <Eyebrow prefix="" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" > {\'\\u00a0\'} </Eyebrow> )}',
    );
  });

  // Mutation caught: the label put back to ETA over a list ordered by when
  // each purchase order last changed, or the order changed under the label.
  it('the sort label says how the rows are ordered: by when each last changed', () => {
    expect(code).toContain(".order('updated_at', { ascending: false })");
    expect(code).toContain('Sort · Recently updated');
    expect(code).not.toContain('Sort · ETA');
  });

  // Mutation caught: a bar that reads 47% received whatever was received.
  it('no partial-receipt bar: the list reads no quantities to draw one; the words stay', () => {
    expect(code).not.toContain('StockBar');
    expect(code).not.toMatch(/\b47\b/);
    expect(code).toContain(
      '{isPartial ? ( <Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 12 }}> partial receipt in progress </Mono> ) : null}',
    );
  });

  it('a purchase order with no destination: a button VoiceOver hears as dimmed, that opens nothing, saying why at full strength', () => {
    expect(code).toContain('const receivable = Boolean(po.destination_warehouse_id);');
    expect(code).toMatch(
      /<Pressable onPress=\{onPress\} disabled=\{!receivable\} accessibilityRole="button" accessibilityState=\{\{ disabled: !receivable \}\}/,
    );
    expect(code).toContain('function open(po: OpenPo) { if (!po.destination_warehouse_id) return;');
    // The details fade; the reason is outside the faded part, in the warning tone.
    expect(code).toContain('<View style={{ opacity: receivable ? 1 : 0.55 }}>');
    expect(code).toMatch(
      /<\/View> \{!receivable \? \( <Mono size=\{11\} color=\{c\.warnText\} style=\{\{ marginTop: 8 \}\}> Set destination on web before receiving <\/Mono> \) : null\} <\/Card>/,
    );
  });

  it('the AI scan card is a button to Scan a PO', () => {
    expect(code).toContain(
      '<Pressable onPress={() => router.push(\'/scan-po\')} accessibilityRole="button"',
    );
  });

  it('every word on the tab survives, word for word', () => {
    for (const words of [
      'Receive <Em>POs.</Em>',
      '<Eyebrow>AI · BETA</Eyebrow>',
      'Scan packing slip <Em>with AI</Em>',
      '30 seconds, no manual entry',
      '<Eyebrow>OPEN PURCHASE ORDERS</Eyebrow>',
      "— {po.supplier_name ?? 'No supplier'}",
      '<SmallStat label="TOTAL" value={`$${po.total.toFixed(0)}`} />',
      '<SmallStat label="ETA" value={etaText} mono />',
      "if (s === 'expected_inbound') return { label: 'EXPECTED', status: 'default' };",
      "if (s === 'ordered') return { label: 'ORDERED', status: 'default' };",
      "if (s === 'partially_received') return { label: 'PARTIAL', status: 'warn' };",
      'accessibilityLabel="Back"',
      'accessibilityLabel="Open menu"',
    ]) {
      expect(code).toContain(words);
    }
  });
});

describe('the rows and controls VoiceOver and a finger reach', () => {
  // Mutation caught: a row that opens a purchase order or an import put back
  // as an unnamed element with no role.
  it.each([
    [PO_LIST, 'POCard'],
    [IMPORTS, 'ImportCard'],
    [RECEIVE, 'POCard'],
  ])('%s: each %s is a button', (file, card) => {
    const sf = treeOf(file);
    const fn = sf.statements.find(
      (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === card,
    );
    expect(fn).toBeDefined();
    const presses: JsxNode[] = [];
    walkJsx(fn!, (el) => {
      if (TOUCHABLE_TAG.test(tagOf(el, sf))) presses.push(el);
    });
    expect(presses).toHaveLength(1);
    expect(attrText(presses[0]!, 'accessibilityRole', sf)).toBe('button');
  });

  // Mutation caught: a header pill back to a ~30pt box with a hitSlop.
  it.each([PO_LIST, IMPORTS])('%s: the header pills are buttons in 44pt frames', (file) => {
    const code = flatCode(file);
    expect(code).toContain("headerActionFrame: { minHeight: 44, justifyContent: 'center' },");
    expect(code).toContain(
      'style={({ pressed }) => [styles.headerActionFrame, { opacity: pressed ? 0.7 : 1 }]}',
    );
    expect(code).not.toContain('hitSlop');
    // The control's edge is the stronger border on the card fill.
    expect(code).toContain(
      '<View style={[styles.headerAction, { borderColor: c.hair2, backgroundColor: c.card }]}>',
    );
  });

  it('the PO list keeps Imports for everyone and Scan PO for those who manage purchase orders', () => {
    const code = flatCode(PO_LIST);
    expect(code).toContain(
      "const canManage = role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage');",
    );
    expect(code).toContain(
      '<HeaderAction icon={Upload} label="Imports" onPress={() => router.push(\'/po-imports\' as never)} />',
    );
    expect(code).toContain(
      '{canManage ? ( <HeaderAction icon={ScanLine} label="Scan PO" onPress={() => router.push(\'/scan-po\')} /> ) : null}',
    );
    expect(code).toContain(
      "onPress={() => router.push({ pathname: '/po/[id]', params: { id: p.id } } as never)}",
    );
    expect(code).toContain('accessibilityRole="button"');
  });

  it('Import history keeps Scan PO for managers or those who manage purchase orders', () => {
    const code = flatCode(IMPORTS);
    expect(code).toContain(
      "const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);",
    );
    expect(code).toContain(
      "const canManage = isManager || (role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage'));",
    );
    expect(code).toMatch(
      /trailing=\{ canManage \? \( <Pressable onPress=\{\(\) => router\.push\('\/scan-po'\)\} accessibilityRole="button"/,
    );
    expect(code).toContain('Scan PO');
    expect(code).toContain(
      "onPress={() => router.push({ pathname: '/po-import/[id]', params: { id: i.id } })}",
    );
    // Re-read on focus, so a review's outcome shows on return.
    expect(code).toContain('useFocusEffect( React.useCallback(() => { void load(); }, [load]), );');
  });

  // Mutation caught: a mailto or tel line back to a bare 11.5pt text target.
  it('a supplier email and phone are links, each in a 44pt frame', () => {
    const { sf, els } = elements(SUPPLIERS, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els).toHaveLength(2);
    for (const el of els) {
      expect(attrText(el, 'accessibilityRole', sf), where(SUPPLIERS, el, sf)).toBe('link');
      expect(attrText(el, 'style', sf)).toContain('styles.link');
    }
    const code = flatCode(SUPPLIERS);
    expect(code).toContain(
      "link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },",
    );
    expect(code).toContain('Linking.openURL(`mailto:${supplier.email}`).catch(() => undefined)');
    expect(code).toContain('Linking.openURL(`tel:${supplier.phone}`).catch(() => undefined)');
  });

  // Mutation caught: the switch unnamed again (VoiceOver said "switch, on").
  it("a recurring PO's switch carries the template's name, and is withheld while its write is out", () => {
    const { sf, els } = elements(RECURRING, (el, s) => tagOf(el, s) === 'Toggle');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityLabel', sf)).toBe('row.name');
    expect(attrText(els[0]!, 'value', sf)).toBe('row.enabled');
    expect(attrText(els[0]!, 'onValueChange', sf)).toBe('busy ? undefined : onToggle');
  });

  // Mutation caught: Delete template back to a 10.5pt line with a fixed red.
  it('Delete template is the refusal-red words in a 44pt frame, off while its write is out', () => {
    const { sf, els } = elements(RECURRING, (el, s) => tagOf(el, s) === 'Button');
    expect(els).toHaveLength(1);
    const del = els[0]!;
    expect(attrText(del, 'variant', sf)).toBe('destructive');
    expect(attrText(del, 'onPress', sf)).toBe('onDelete');
    expect(attrText(del, 'disabled', sf)).toBe('busy');
    expect(textOf(del, sf)).toBe('Delete template');
    expect(flatCode(RECURRING)).toMatch(/delete: \{ minHeight: 44,/);
  });

  it('the recurring writes still go through the audited route, and the list changes only after it answers', () => {
    const code = flatCode(RECURRING);
    expect(code).toContain(
      "await api(`/api/v1/recurring-pos/${row.id}`, { method: 'PATCH', body: { enabled: next }, }); setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: next } : r)));",
    );
    expect(code).toContain(
      "await api(`/api/v1/recurring-pos/${row.id}`, { method: 'DELETE' }); setRows((prev) => prev.filter((r) => r.id !== row.id));",
    );
    // setRows changes the rows on screen in place, nothing more.
    expect(code).toContain(
      'const setRows = React.useCallback( (update: (prev: TemplateRow[]) => TemplateRow[]) => setStored((prev) => (prev ? { ...prev, rows: update(prev.rows) } : prev)), [], );',
    );
    for (const words of [
      "'Delete recurring PO?'",
      '`"${row.name}" will stop generating purchase orders. Already-created POs are not affected.`',
      "{ text: 'Keep', style: 'cancel' }",
      "text: 'Delete', style: 'destructive'",
      "'Could not update'",
      "'Could not delete'",
      "'You need manager access to change recurring POs.'",
      "row.send_mode === 'send' ? 'Auto-send' : 'Draft'",
      "row.enabled ? `next ${nextRun}` : 'paused'",
      "supplierObj?.name ?? 'No supplier'",
      'title="Recurring POs"',
    ]) {
      expect(code).toContain(words);
    }
  });

  it('every word on the PO list, Import history and Suppliers survives', () => {
    const po = flatCode(PO_LIST);
    for (const words of [
      'title="Purchase"',
      'italic="orders."',
      "draft: { label: 'DRAFT', status: 'default' },",
      "expected_inbound: { label: 'EXPECTED', status: 'default' },",
      "ordered: { label: 'ORDERED', status: 'default' },",
      "partially_received: { label: 'PARTIAL', status: 'warn' },",
      "received: { label: 'RECEIVED', status: 'ok' },",
      "cancelled: { label: 'CANCELLED', status: 'crit' },",
      "— {po.supplier?.name ?? 'No supplier'}",
      '${po.total.toFixed(0)}',
      '`ETA ${formatCalendarDate(po.expected_at)}`',
      "`created ${new Date(po.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`",
    ]) {
      expect(po).toContain(words);
    }
    const imports = flatCode(IMPORTS);
    for (const words of [
      'title="Import"',
      'italic="history."',
      "uploaded: { label: 'UPLOADED', status: 'default' },",
      "parsing: { label: 'PARSING', status: 'warn' },",
      "parsed: { label: 'PARSED', status: 'ok' },",
      "needs_review: { label: 'REVIEW', status: 'warn' },",
      "approved: { label: 'APPROVED', status: 'ok' },",
      "failed: { label: 'FAILED', status: 'crit' },",
      "duplicate: { label: 'DUPLICATE', status: 'crit' },",
      "canceled: { label: 'CANCELLED', status: 'default' },",
      '— {row.source_type}',
      "{row.vendor?.name ? `${row.vendor.name} · ` : ''}",
      '{` · by ${row.uploader}`}',
      '{row.parse_error}',
    ]) {
      expect(imports).toContain(words);
    }
    const suppliers = flatCode(SUPPLIERS);
    for (const words of [
      'title="Suppliers"',
      'italic="& carriers."',
      '{supplier.name}',
      '{supplier.contact_name}',
      '{supplier.email}',
      '{supplier.phone}',
    ]) {
      expect(suppliers).toContain(words);
    }
  });
});

describe('the colours the lists name read at AA in both modes', () => {
  it.each(MODES)('%s: words on the card and the page, the warning note on its wash', (_m, c) => {
    // The words the lists draw: ink, ink2 (supplier links) and ink3 (every
    // meta line, the stat labels, the eyebrows), on the card and the page.
    for (const fg of [c.ink, c.ink2, c.ink3]) {
      expect(contrast(fg, c.card)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(fg, c.paper)).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // "Set destination on web before receiving" and the failure glyph on the card / page.
    expect(contrast(c.warnText, c.card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(c.warnText, c.paper)).toBeGreaterThanOrEqual(AA_TEXT);
    // The Receive tab's reload note, and its glyph, on the warning wash.
    expect(contrast(c.warnText, c.warnWash)).toBeGreaterThanOrEqual(AA_TEXT);
    // Delete template: refusal-red words on the card.
    expect(contrast(c.critText, c.card)).toBeGreaterThanOrEqual(AA_TEXT);
    // The camera and truck glyphs in their recessed wells.
    expect(contrast(c.ink, c.sunk)).toBeGreaterThanOrEqual(AA_UI);
    // The Receive pip is decoration; it still stands out from its well.
    expect(contrast(c.accent, c.sunk)).toBeGreaterThanOrEqual(AA_UI);
  });
});
