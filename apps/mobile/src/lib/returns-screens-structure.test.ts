import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { PHOTO_BACKGROUND, pillTone, toggleTone } from '../components/ui/tones';
import { createSequenceGuard } from './debounced-list-load';
import {
  TOUCHABLE_TAG,
  attr,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { returnRowWaiting, returnStatusTone } from './returns-view';
import { palette, type Palette } from './theme';

/**
 * THE RETURNS SCREENS, READ AS SOURCE (redesign package P5.7b).
 *
 * The Returns list (app/(drawer)/returns.tsx, with the iPad split view), one
 * RMA (app/returns/[id].tsx and its workbench, return-workbench-view.tsx), the
 * workbench's action sheet, the replacement's release sheet, picker and
 * quantity stepper, and the requester's Return or exchange sheet and request
 * card took the redesign's look on the per-mode palette. These pin what had
 * to survive and what changed:
 *
 *   - every word, role, state and label; the gates (the returns module and
 *     returns:read or returns:manage); keyset paging, the debounced search
 *     and the reload on focus; the iPad split at 900pt with the list 380pt;
 *   - the filters as the reference's filter chips in 44pt frames, still
 *     buttons with a selected state; every control a 44pt target (the order
 *     links and the filters took hitSlop, the small buttons were 36pt);
 *   - statuses on the shared pill tones, photos on the white photo ground,
 *     no fixed colours, no single-mode accents, no word in the faint inks,
 *     and the colours each screen names measured in both modes;
 *   - a defect fixed: a pull to refresh sent before an action could paint
 *     the RMA back to how it was (Receive offered again) when its answer
 *     came in after the action's.
 *
 * The behaviour stays pinned where it was: returns-screen-wiring,
 * returns-exchange-wiring, requester-returns-wiring, returns-view.still-
 * waiting and exception-sheets-keyboard-wiring. The mobile suite has no React
 * Native renderer, so the screens are read with the TypeScript parser.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const LIST = 'app/(drawer)/returns.tsx';
const RMA = 'app/returns/[id].tsx';
const VIEW = 'src/components/return-workbench-view.tsx';
const SHEET = 'src/components/return-action-sheet.tsx';
const RELEASE = 'src/components/release-replacement-sheet.tsx';
const PICKER = 'src/components/replacement-picker-list.tsx';
const STEPPER = 'src/components/replacement-quantity-stepper.tsx';
const REQUESTER = 'src/components/requester-return-sheet.tsx';
const TRACKING = 'src/components/requester-tracking-card.tsx';
const FILES = [LIST, RMA, VIEW, SHEET, RELEASE, PICKER, STEPPER, REQUESTER, TRACKING];
const SHEETS = [SHEET, RELEASE, REQUESTER];

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

function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(sf, (el, ancestors) => {
    if (match(el, sf)) els.push({ el, ancestors: [...ancestors] });
  });
  return { sf, els };
}

/** A StyleSheet entry `  name: { ... }` of a file, as source text. */
function styleBlock(file: string, name: string): string {
  const m = new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(sourceOf(file));
  expect(m, `styles.${name} in ${file}`).not.toBeNull();
  return m![1]!;
}

/** Everything a person can read or hear in a file: JSX text and literals. */
function wordsOf(file: string): string[] {
  const sf = treeOf(file);
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

describe('the per-mode palette on every returns screen', () => {
  it.each(FILES)('%s: no fixed colours, no single-mode accents, no faint words', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    // ACCENT's crit is under AA as words in one mode or the other.
    expect(code).not.toMatch(/\bACCENT\b/);
    // The light-only legacy alias.
    expect(code).not.toMatch(/\btheme\./);
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    // paper2 is the card colour in dark (a recessed fill is sunk); ink5 and
    // ink4 are under AA as words and placeholders.
    expect(code).not.toMatch(/\bc\.(paper2|ink5)\b/);
    const ink4 = code.match(/\bc\.ink4\b/g) ?? [];
    // The one faint mark left: the empty list's decorative glyph.
    expect(ink4).toHaveLength(file === LIST ? 1 : 0);
    if (file === LIST) expect(flatCode(LIST)).toContain('<Undo2 size={32} color={c.ink4}');
  });

  // Mutation caught: the scrim pair changed, or a translucent fill added.
  it.each(FILES)('%s: translucent colour only in the shared sheet scrim', (file) => {
    const rgba = codeOnly(sourceOf(file)).match(/rgba?\([^)]*\)/g) ?? [];
    expect(rgba).toEqual(SHEETS.includes(file) ? ['rgba(0,0,0,0.6)', 'rgba(14,15,13,0.4)'] : []);
  });

  // Mutation caught: a word or a glyph in a token that is not a text colour.
  it.each(FILES)('%s: every colour given to words or glyphs is a text token', (file) => {
    const TEXT_TOKENS = new Set(['accent', 'critText', 'ink', 'ink2', 'ink3', 'paper', 'warnText']);
    const code = flatCode(file).replace('<Undo2 size={32} color={c.ink4}', '');
    const uses = [
      ...code.matchAll(/\b(?:color|placeholderTextColor)=\{[^}]*\}/g),
      ...code.matchAll(/\bcolor: [^,}\]]+/g),
    ];
    // The route draws only the back chip, whose glyph colour is the chip's own.
    if (file !== RMA) expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      for (const t of m[0].matchAll(/\bc\.(\w+)/g)) {
        expect(TEXT_TOKENS.has(t[1]!), `${file}: ${m[0]}`).toBe(true);
      }
    }
  });

  // Mutation caught: hitSlop back on a filter or an order link (it never
  // reaches past the parent's bounds and loses to an overlapping sibling).
  it.each(FILES)('%s: no hitSlop: every target is a real frame', (file) => {
    expect(codeOnly(sourceOf(file))).not.toMatch(/\bhitSlop=/);
  });

  // Mutation caught: a small button back at its 36pt.
  it.each(FILES)('%s: every small button is a 44pt target', (file) => {
    const { sf, els } = elements(
      file,
      (el, s) => tagOf(el, s) === 'Button' && attrText(el, 'size', s) === 'sm',
    );
    for (const { el } of els) {
      expect(attrText(el, 'style', sf), el.getText(sf)).toBe('{ minHeight: MIN_TAP }');
    }
  });

  it.each([LIST, VIEW, SHEET, REQUESTER])(
    '%s: a photo sits on the white photo ground, a missing one is the recessed square',
    (file) => {
      const code = flatCode(file);
      expect(code).toMatch(
        /import \{ PHOTO_BACKGROUND(, toggleTone)? \} from '@\/components\/ui\/tones';/,
      );
      const grounds =
        code.match(/backgroundColor: PHOTO_BACKGROUND, borderColor: c\.hair \}/g) ?? [];
      const wells = code.match(/backgroundColor: c\.sunk, borderColor: c\.hair \}/g) ?? [];
      expect(grounds.length).toBeGreaterThan(0);
      expect(wells.length).toBe(grounds.length);
    },
  );
});

describe('Returns list', () => {
  const code = flatCode(LIST);

  // Mutation caught: the role, the selected state or the name dropped from a
  // filter; the 44pt frame or the chip recipe changed.
  it('the filters are the reference filter chips in 44pt frames, buttons that say which is chosen', () => {
    expect(code).toContain('const filters = availableReturnListFilters({ exchanges: true });');
    const { sf, els } = elements(
      LIST,
      (el, s) => attrText(el, 'onPress', s) === '() => setFilter(f.id)',
    );
    expect(els).toHaveLength(1);
    const chip = els[0]!.el;
    expect(tagOf(chip, sf)).toBe('Pressable');
    expect(attrText(chip, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(chip, 'accessibilityState', sf)).toBe('{ selected: filter === f.id }');
    expect(attrText(chip, 'accessibilityLabel', sf)).toBe('f.label');
    expect(attrText(chip, 'style', sf)).toBe(
      '({ pressed }) => [styles.chipFrame, { opacity: pressed ? 0.7 : 1 }]',
    );
    expect(styleBlock(LIST, 'chipFrame')).toMatch(/minHeight: 44, minWidth: 44,/);
    expect(styleBlock(LIST, 'chip')).toMatch(/minHeight: 32,[\s\S]*borderRadius: 999,/);
    expect(code).toContain(
      "filter === f.id ? { backgroundColor: c.ink, borderColor: c.ink } : { backgroundColor: 'transparent', borderColor: c.hair2 },",
    );
    expect(code).toContain(
      'style={[styles.chipLabel, { color: filter === f.id ? c.paper : c.ink2 }]} maxFontSizeMultiplier={CONTROL_CAP} > {f.label}',
    );
    expect(code).toContain('const CONTROL_CAP = capTo(13, TYPE_CEILING.control);');
  });

  it('keeps the gate, the words, the search and the header', () => {
    expect(code).toContain("const enabled = enabledModules.has('returns');");
    expect(code).toContain(
      "const canRead = showWriteCta(perms, 'returns:read') || showWriteCta(perms, 'returns:manage');",
    );
    expect(code).toContain(
      '<Field label="SEARCH" value={q} onChangeText={setQ} placeholder={RETURNS_COPY.listSearchPlaceholder}',
    );
    expect(code).toContain(
      '<Display size={32} style={{ marginTop: 12 }}> Returns <Em>and RMAs.</Em> </Display>',
    );
    expect(code).toContain('<Display size={18}>{RETURNS_COPY.listEmpty}</Display>');
    const words = wordsOf(LIST);
    for (const w of [
      'RETURNS',
      'Returns',
      'and RMAs.',
      'Returns aren’t enabled for this workspace. Ask an admin to enable them in Settings → Modules.',
      'You don’t have permission to view returns.',
      'Try again',
      'Choose a return to see it here.',
      'Back',
      'Open menu',
      'SEARCH',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('keyset pages, the debounced search and the reload on focus are unchanged', () => {
    expect(code).toContain('const SEARCH_DEBOUNCE_MS = 250;');
    expect(code).toContain('const page = await listReturns({ filter, q });');
    expect(code).toContain('const page = await listReturns({ filter, q, cursor });');
    expect(code).toContain('onEndReached={() => void loadMore()}');
    expect(code).toContain('if (!cursor || loadingMore || loading) return;');
    expect(code).toMatch(
      /useFocusEffect\( React\.useCallback\(\(\) => \{ scheduler\.schedule\(\(\) => void load\(\)\); \}, \[load, scheduler\]\), \);/,
    );
  });

  // Mutation caught: the split moved, the list column resized, the chosen
  // row back on a colour alone.
  it('the iPad split keeps its 900pt break, its 380pt list and the workbench beside it', () => {
    expect(code).toContain('const SPLIT_MIN_WIDTH = 900;');
    expect(styleBlock(LIST, 'splitList')).toBe(' width: 380, flexGrow: 0 ');
    expect(code).toContain(
      '<ReturnWorkbenchView key={selectedId} returnId={selectedId} compact onChanged={() => scheduler.schedule(() => void load())} />',
    );
    expect(code).toContain(
      'split ? setSelectedId(item.id) : router.push(`/returns/${item.id}` as Href)',
    );
    // DESIGN-SPEC 6.18: the chosen row's 3pt accent rail on the recessed
    // fill; the padding gives the rail's extra 2pt back.
    expect(code).toContain(
      'selected ? { borderLeftWidth: 3, borderLeftColor: c.accent, backgroundColor: c.sunk, paddingLeft: 14, } : undefined',
    );
  });

  it('each RMA: a button named with its words, its status on the shared pill tones, its wait in the warning ink past the prompt', () => {
    const { sf, els } = elements(LIST, (el, s) => attrText(el, 'onPress', s) === 'onPress');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!.el, 'accessibilityLabel', sf)).toBe('label');
    expect(attrText(els[0]!.el, 'accessibilityState', sf)).toBe('{ selected }');
    expect(code).toContain(
      '<Pill status={returnStatusTone(row.status)} dot={false}> {returnStatusLabel(row.status)} </Pill>',
    );
    expect(code).toContain(
      '<Mono size={9.5} tracking={0.2} upper color={c.ink3}> {returnRowTitle(row)} </Mono>',
    );
    expect(code).toContain('color={waiting.overdue ? c.warnText : c.ink3}');
    expect(styleBlock(LIST, 'thumb')).toBe(
      ' width: 36, height: 36, borderRadius: 7, borderWidth: 1 ',
    );
  });

  // Mutation caught: the failure back as plain words in a card, the reload
  // note off the warning wash, the alert role dropped.
  it('a failed read says so with the warning glyph; a failed reload over rows is the warning-wash note', () => {
    expect(code).toContain(
      '<TriangleAlert size={32} color={c.warnText} strokeWidth={1.3} style={{ marginBottom: 12 }} /> <Body size={14.5} accessibilityRole="alert" style={{ textAlign: \'center\', maxWidth: 320 }} > {loadError} </Body>',
    );
    expect(code).toContain('<View style={[styles.banner, { backgroundColor: c.warnWash }]}>');
    expect(code).toContain(
      '<Body size={13.5} color={c.warnText} accessibilityRole="alert" style={{ flex: 1 }} > {loadError} </Body>',
    );
    expect(code).toContain('{loadError && rows.length === 0 ? (');
    expect(code).toContain('loadError && rows.length > 0 ? (');
  });
});

describe('one RMA (the route)', () => {
  const code = flatCode(RMA);
  it('a back chip named Back that falls back to the Returns list, over the workbench', () => {
    expect(code).toContain(
      '<IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />',
    );
    expect(code).toContain("else router.replace('/returns');");
    expect(code).toContain('{id ? <ReturnWorkbenchView returnId={id} /> : null}');
  });
});

describe('the workbench', () => {
  const code = flatCode(VIEW);

  // The defect: a pull to refresh sent before Receive (or any action) that
  // answered after it painted the RMA back to how it was, offering Receive
  // again until the next read.
  describe('only the newest read or answer paints the RMA (defect fix)', () => {
    it('every read takes a number and paints only while it is the newest', () => {
      expect(code).toContain('const [reads] = React.useState(() => createSequenceGuard());');
      expect(code).toContain(
        'const seq = reads.next(); setLoadError(null); try { const next = await getReturnWorkbench(returnId); if (reads.isCurrent(seq)) setWb(next); } catch (e) { if (reads.isCurrent(seq)) setLoadError(describeReturnError(e)); } finally { if (reads.isCurrent(seq)) setLoading(false); setRefreshing(false); }',
      );
    });

    it("every action's answer goes through adopt, which outranks the reads on their way", () => {
      expect(code).toContain(
        'function adopt(next: MobileReturnWorkbench) { reads.next(); setWb(next); }',
      );
      expect(code.match(/adopt\(res\.workbench\);/g)).toHaveLength(2);
      expect(code).toContain('if (done.workbench) adopt(done.workbench); else void load();');
      // setWb only in the read, in adopt and in the reset for a new RMA.
      expect(code.match(/\bsetWb\(/g)).toHaveLength(3);
      expect(code).toContain('setWb(null);');
    });

    it('the guard the screen uses drops a read that was overtaken by an answer', () => {
      const reads = createSequenceGuard();
      const pull = reads.next(); // the pull to refresh is sent
      reads.next(); // Receive answers first: adopt
      expect(reads.isCurrent(pull)).toBe(false); // the pull's older RMA is dropped
      const after = reads.next(); // a read after the answer
      expect(reads.isCurrent(after)).toBe(true);
    });
  });

  it('nothing read: the words with the no-connection or the warning glyph, and Try again at 44pt', () => {
    expect(code).toContain(
      '{offline ? ( <WifiOff size={32} color={c.ink3} strokeWidth={1.3} style={{ marginBottom: 12 }} /> ) : ( <TriangleAlert size={32} color={c.warnText} strokeWidth={1.3} style={{ marginBottom: 12 }} /> )}',
    );
    expect(code).toContain(
      '{offline ? READINESS_NEEDS_CONNECTION_COPY : (loadError ?? "This return isn\'t available.")}',
    );
    expect(code).toContain(
      '<Button variant="outline" size="sm" disabled={offline} style={{ minHeight: MIN_TAP }} onPress={() => void load()} > Try again </Button>',
    );
  });

  it('the offline and unreadable-destination notes are on the warning wash with their glyphs', () => {
    expect(code).toContain(
      '<WifiOff size={16} color={c.warnText} strokeWidth={1.75} style={{ marginTop: 2 }} /> <Body size={13.5} color={c.warnText} style={{ flex: 1 }}> {RETURNS_COPY.offlineActionsWait} </Body>',
    );
    expect(code).toContain(
      '<TriangleAlert size={16} color={c.warnText} strokeWidth={1.75} style={{ marginTop: 2 }} /> <Body size={13.5} color={c.warnText} accessibilityRole="alert" style={{ flex: 1 }}> {RETURNS_COPY.destinationsUnavailable} </Body>',
    );
    expect(
      code.match(/<View style=\{\[styles\.banner, \{ backgroundColor: c\.warnWash \}\]\}>/g),
    ).toHaveLength(2);
    expect(styleBlock(VIEW, 'banner')).toMatch(/padding: 12,\s*borderRadius: 10,/);
  });

  // Mutation caught: an order link back to its 21pt line with hitSlop.
  it('the two order links are links in 44pt frames', () => {
    const { sf, els } = elements(VIEW, (el, s) => attrText(el, 'accessibilityRole', s) === 'link');
    expect(els).toHaveLength(2);
    for (const { el } of els) {
      expect(tagOf(el, sf)).toBe('Pressable');
      expect(attrText(el, 'style', sf)).toBe(
        '({ pressed }) => [styles.link, { opacity: pressed ? 0.7 : 1 }]',
      );
    }
    expect(attrText(els[0]!.el, 'accessibilityLabel', sf)).toBe('`Against order ${so}`');
    expect(attrText(els[1]!.el, 'accessibilityLabel', sf)).toBe('t.text');
    expect(styleBlock(VIEW, 'link')).toMatch(/minHeight: MIN_TAP, justifyContent: 'center'/);
  });

  it('the next step is the ink button, the others outline (Deny the refusal words), each 44pt', () => {
    const { sf, els } = elements(VIEW, (el, s) => tagOf(el, s) === 'Button');
    const primary = els.find(
      ({ el }) => attrText(el, 'onPress', sf) === '() => onAction(actions.primary!)',
    );
    expect(primary).toBeDefined();
    expect(attr(primary!.el, 'variant', sf)).toBeUndefined();
    expect(attrText(primary!.el, 'block', sf)).toBe('true');
    const secondary = els.find(({ el }) => attrText(el, 'onPress', sf) === '() => onAction(a)');
    expect(attrText(secondary!.el, 'variant', sf)).toBe("a === 'deny' ? 'destructive' : 'outline'");
    expect(attrText(secondary!.el, 'style', sf)).toBe('{ minHeight: MIN_TAP }');
  });

  it('statuses on the shared pill tones; a short replacement line in the refusal ink; the history time in the muted ink', () => {
    expect(code).toContain('<Pill status={returnStatusTone(r.status)} dot={false}>');
    expect(code).toContain(
      "<Pill dot={false} status={ex.status === 'unavailable' ? 'crit' : 'default'}>",
    );
    expect(code).toContain("<Pill status={l.applied ? 'ok' : 'default'} dot={false}>");
    expect(code).toMatch(
      /color=\{ ?t\.tone === 'ink' \? c\.ink : t\.tone === 'crit' \? c\.critText : undefined ?\}/,
    );
    expect(code).toContain('<Mono size={11} color={c.ink3}> {new Date(e.at).toLocaleString(');
    expect(styleBlock(VIEW, 'photo')).toBe(
      ' width: 72, height: 72, borderRadius: 10, borderWidth: 1 ',
    );
  });

  it('keeps its words', () => {
    const words = wordsOf(VIEW);
    for (const w of [
      'Against order ',
      'Saving…',
      'No further steps for this return.',
      'DENIED',
      'HISTORY',
      'No history yet.',
      'Return',
      "This return isn't available.",
      'Try again',
      'RMA ·',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('the action sheet', () => {
  const code = flatCode(SHEET);

  it('a chosen row is the ink edge on the recessed fill, an idle one the control border', () => {
    // Release presets, delivery sites, the exchange review's choices and the
    // destinations.
    expect(
      code.match(
        /borderColor: (reason === preset|siteKey === o\.key|checked) \? c\.ink : c\.hair2, backgroundColor: \1 \? c\.sunk : 'transparent',/g,
      ),
    ).toHaveLength(4);
    // Restock / Scrap: the reference's chip, the ink fill when chosen.
    expect(code).toContain(
      "borderColor: checked ? c.ink : c.hair2, backgroundColor: checked ? c.ink : 'transparent',",
    );
    expect(code).toContain(
      "<Body size={14} color={checked ? c.paper : c.ink2}> {d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap} </Body>",
    );
  });

  it('the reason boxes are on the shared Field recipe with the muted placeholder', () => {
    expect(
      code.match(
        /style=\{\[styles\.input, \{ borderColor: c\.hair2, backgroundColor: c\.card, color: c\.ink/g,
      ),
    ).toHaveLength(2);
    expect(code.match(/placeholderTextColor=\{c\.ink3\}/g)).toHaveLength(2);
    expect(code).toContain(
      '<Mono size={11} color={reasonCount > reasonMax ? c.critText : c.ink3}>',
    );
  });

  // Mutation caught: the switch's name, hint or disabled state dropped, or
  // its colours off the shared switch recipe.
  it('the item-is-here switch keeps its name, hint and lock, in the shared switch colours', () => {
    expect(code).toContain(
      '<Switch value={itemIsHere} onValueChange={setItemIsHere} disabled={submitting} accessibilityLabel={RETURNS_COPY.itemIsHere} accessibilityHint={RETURNS_COPY.itemIsHereHelp} trackColor={{ false: toggleTone(false, c).track, true: toggleTone(true, c).track }} ios_backgroundColor={toggleTone(false, c).track} thumbColor={toggleTone(itemIsHere, c).knob} />',
    );
  });

  it("refusals, the short lines and the consequences' warnings are in the refusal ink", () => {
    expect(code).toContain("color={t.key === 'effect' ? c.ink3 : c.critText}");
    expect(code).toContain('<Body key={t} size={13.5} color={c.critText}>');
    expect(code).toContain(
      '<Body size={13} color={c.critText} accessibilityRole="alert"> {error} </Body>',
    );
    expect(code).toContain('<X size={18} color={c.ink3} />');
  });

  it('keeps its words', () => {
    const words = wordsOf(SHEET);
    for (const w of [
      'Deny this return?',
      'Cancel this return?',
      'Save destination',
      'Why the return is denied',
      'Why the return is cancelled',
      'Why the return is cancelled (optional)',
      'Why',
      'WHAT HAPPENS WHEN YOU APPROVE',
      'Saving…',
      'Saved.',
      'Destination saved.',
      'Nothing changed.',
      'Return denied.',
      'Already denied.',
      'Return cancelled.',
      'Already cancelled.',
      'New replacement issued.',
      'Replacement changed.',
      'Nothing to close.',
      'Close',
      'Item',
      'At most ',
      ' characters.',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('the release sheet, the replacement picker and its stepper', () => {
  it('release: a chosen preset is the ink edge on the recessed fill; the reason box on the Field recipe', () => {
    const code = flatCode(RELEASE);
    expect(code).toContain(
      "borderColor: reason === preset ? c.ink : c.hair2, backgroundColor: reason === preset ? c.sunk : 'transparent', minHeight: MIN_TAP,",
    );
    expect(code).toContain(
      'placeholderTextColor={c.ink3} accessibilityLabel={RETURNS_COPY.releaseEarlyReasonLabel} style={[ styles.input, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }, ]}',
    );
    expect(code).toContain(
      '<Mono size={11} color={count > RETURN_RELEASE_REASON_MAX ? c.critText : c.ink3}>',
    );
    expect(code).toContain('<Body size={13} color={c.critText} accessibilityRole="alert">');
    expect(code).toContain('<X size={18} color={c.ink3} />');
    for (const w of ['Why', 'Close', 'Saving…']) expect(wordsOf(RELEASE), w).toContain(w);
  });

  it('picker: a chosen size is the ink edge on the recessed fill; the SKU in mono; a short row in the refusal ink', () => {
    const code = flatCode(PICKER);
    expect(code).toContain(
      "borderColor: checked ? c.ink : c.hair2, backgroundColor: checked ? c.sunk : 'transparent', minHeight: MIN_TAP,",
    );
    expect(code).toContain('<Mono size={11.5} color={c.ink3}> {row.sku} </Mono>');
    expect(code).toContain('<Body size={12.5} color={row.short ? c.critText : c.ink3}>');
    expect(code).toContain(
      'style={[styles.input, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }]}',
    );
    expect(code).toContain('placeholderTextColor={c.ink3}');
  });

  it('stepper: the reference stepper buttons at 44pt, the card fill with the control border', () => {
    const code = flatCode(STEPPER);
    expect(code).toContain(
      'minWidth: MIN_TAP, minHeight: MIN_TAP, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: c.hair2, backgroundColor: c.card,',
    );
  });
});

describe("the requester's Return or exchange sheet and request card", () => {
  const code = flatCode(REQUESTER);

  // Mutation caught: a choice chip off the reference recipe or under 44pt.
  it('Return only / Exchange and the reasons are the reference chips, 44pt, their words capped as controls', () => {
    expect(code).toContain(
      "const choiceStyle = (on: boolean) => ({ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, minHeight: MIN_TAP, justifyContent: 'center' as const, borderColor: on ? c.ink : c.hair2, backgroundColor: on ? c.ink : 'transparent', });",
    );
    expect(
      code.match(
        /<Body size=\{13\} color=\{on \? c\.paper : c\.ink2\} maxFontSizeMultiplier=\{CHOICE_CAP\} ?>/g,
      ),
    ).toHaveLength(2);
    expect(code).toContain('const CHOICE_CAP = capTo(13, TYPE_CEILING.control);');
    expect(code.match(/style=\{choiceStyle\(on\)\}/g)).toHaveLength(2);
  });

  it('a size row: the ink edge on the recessed fill when chosen; "Not in stock right now" in the warning ink', () => {
    expect(code).toContain(
      "borderColor: checked ? c.ink : c.hair2, backgroundColor: checked ? c.sunk : 'transparent',",
    );
    expect(code).toContain('<Body size={12.5} color={row.available ? c.ink3 : c.warnText}>');
    expect(code).toContain(
      '<Mono size={11} color={c.ink3}> {requesterLineAvailability(l)} </Mono>',
    );
  });

  it('the steppers and the text boxes on the control recipe; Try again at 44pt; refusals in the refusal ink', () => {
    expect(code).toContain(
      'borderRadius: 10, borderWidth: 1, borderColor: c.hair2, backgroundColor: c.card,',
    );
    expect(
      code.match(
        /style=\{\[ ?styles\.input, \{ borderColor: c\.hair2, backgroundColor: c\.card, color: c\.ink \},? ?\]\}/g,
      ),
    ).toHaveLength(2);
    expect(code.match(/placeholderTextColor=\{c\.ink3\}/g)).toHaveLength(2);
    expect(code.match(/style=\{\{ minHeight: MIN_TAP \}\}/g)).toHaveLength(3);
    expect(code).toContain('<Body size={13} color={c.critText} accessibilityRole="alert">');
    expect(code).toContain(
      '<Mono size={11} color={count > RETURN_EXCHANGE_NOTE_MAX ? c.critText : c.ink3}>',
    );
  });

  it('keeps its words', () => {
    const words = wordsOf(REQUESTER);
    for (const w of [
      'Try again',
      'Close',
      'REASON',
      'NOTES',
      'Reason',
      'Return one fewer',
      'Return one more',
      ' returning',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('the request card: one VoiceOver element, its date in the muted ink', () => {
    const card = flatCode(TRACKING);
    expect(card).toContain(
      '<View accessible accessibilityLabel={v.accessibilityLabel} style={{ gap: 8 }}>',
    );
    expect(card).toContain('<Mono size={10.5} color={c.ink3}> {v.date} </Mono>');
    const { els } = elements(TRACKING, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els).toHaveLength(0);
  });
});

describe('the colours, measured in both modes', () => {
  it.each(MODES)('%s: words at 4.5:1 on what they sit on', (_mode, c) => {
    const pairs: [string, string, string][] = [
      ['filter chip words (ink2) on the page', c.ink2, c.paper],
      ['chosen chip words (paper) on the ink fill', c.paper, c.ink],
      ['handles, times, SKUs, counts, placeholders (ink3) on the card', c.ink3, c.card],
      ['muted words (ink3) on a chosen row (sunk)', c.ink3, c.sunk],
      ['"Choose a return to see it here." (ink3) on the page', c.ink3, c.paper],
      ["a chosen row's words (ink) on sunk", c.ink, c.sunk],
      ['idle sheet chip words (ink2) on the card', c.ink2, c.card],
      ['an overdue wait, "Not in stock right now" (warnText) on the card', c.warnText, c.card],
      ['the same on a chosen row (sunk)', c.warnText, c.sunk],
      ['the notes on the warning wash', c.warnText, c.warnWash],
      ['refusals, short lines, the over-limit count (critText) on the card', c.critText, c.card],
      ['a short availability on a chosen picker row (sunk)', c.critText, c.sunk],
      ['failure words (ink) on the page', c.ink, c.paper],
    ];
    for (const [what, fg, bg] of pairs) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(MODES)('%s: marks and edges at 3:1', (_mode, c) => {
    const knobOff = toggleTone(false, c);
    const knobOn = toggleTone(true, c);
    const pairs: [string, string, string][] = [
      ['the chosen RMA rail (accent) on its sunk fill', c.accent, c.sunk],
      ['the chosen RMA rail (accent) against the page', c.accent, c.paper],
      ['the warning glyph (warnText) on the page', c.warnText, c.paper],
      ['the glyphs (warnText) on the warning wash', c.warnText, c.warnWash],
      ['the no-connection glyph (ink3) on the page', c.ink3, c.paper],
      ['the Close X (ink3) on the sheet', c.ink3, c.card],
      ['a chosen row edge (ink) on the card', c.ink, c.card],
      ['a chosen chip fill (ink) on the card', c.ink, c.card],
      ['a chosen chip fill (ink) on the page', c.ink, c.paper],
      ['the switch knob on its track, on', knobOn.knob, knobOn.track],
      ['the switch knob on its track, off', knobOff.knob, knobOff.track],
      ['the switch knob, off, against the sheet', knobOff.knob, c.card],
      ['the empty-list glyph (ink4) on the page', c.ink4, c.paper],
    ];
    for (const [what, fg, bg] of pairs) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it.each(MODES)('%s: every return status pill reads at 4.5:1 on its own fill', (_mode, c) => {
    for (const status of ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled']) {
      const tone = pillTone(returnStatusTone(status), c);
      expect(contrast(tone.fg, tone.bg), status).toBeGreaterThanOrEqual(AA_TEXT);
    }
    expect(returnStatusTone('requested')).toBe('warn');
    expect(returnStatusTone('closed')).toBe('ok');
    expect(returnStatusTone('denied')).toBe('crit');
  });

  it('the photo ground is the shared white in both modes', () => {
    expect(PHOTO_BACKGROUND).toBe('#ffffff');
  });

  it('the overdue rule the wait colour follows is the 14-day prompt', () => {
    const row = (waitingDays: number) =>
      ({ status: 'approved', waitingDays }) as Parameters<typeof returnRowWaiting>[0];
    expect(returnRowWaiting(row(13))?.overdue).toBe(false);
    expect(returnRowWaiting(row(14))?.overdue).toBe(true);
  });
});
