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
import { RADIUS, palette, type Palette } from './theme';

/**
 * THE STORAGE LISTS AND THE LOCATION SCREEN, READ AS SOURCE (redesign
 * package P5.9b).
 *
 * Categories, Tags, Procedures, Movements and Locations (src/screens, also the
 * optional bottom tabs) and the location screen (app/location/[id].tsx) took
 * the redesign's look on the per-mode palette: informational words in muted
 * ink3 or stronger, the per-mode warning and refusal tones, recessed wells on
 * cards. These pin what had to survive it and what the package fixed:
 *
 *   - every word, eyebrow and empty sentence, word for word;
 *   - a failed read is said in DataListScreen's `failed` panel with each
 *     list's own words, never as "No categories yet." (CONFLICTS D25): a
 *     failed refresh keeps the rows and says so above them, a workspace
 *     switch never shows another workspace's rows, and with no workspace a
 *     pull loads it again (each screen's own `settleList` is run below);
 *   - rows that open something are buttons to VoiceOver;
 *   - the Movements ledger is one surface of hairline rows (the reference's
 *     phone list), never a card per movement.
 *
 * The Staging worklist, in the same package, is read by
 * staging-structure.test.ts.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, as scanner-structure.test.ts and
 * header-chip-a11y.test.ts read theirs, and the colours each screen names are
 * measured with the palette they come from.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const CATEGORIES = 'src/screens/categories.tsx';
const TAGS = 'src/screens/tags.tsx';
const PROCEDURES = 'src/screens/procedures.tsx';
const MOVEMENTS = 'src/screens/movements.tsx';
const LOCATIONS = 'src/screens/locations.tsx';
const LOCATION = 'app/location/[id].tsx';
const FILES = [CATEGORIES, TAGS, PROCEDURES, MOVEMENTS, LOCATIONS, LOCATION];

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

/** A StyleSheet entry `  name: { ... }` of a source, as source text. */
function styleBlockOf(src: string, name: string, where: string): string {
  const m = new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(src);
  expect(m, `styles.${name} in ${where}`).not.toBeNull();
  return m![1]!;
}

/** A string as a regular expression that matches it literally. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

describe('the per-mode palette on every screen of the package', () => {
  it.each(FILES)('%s: no fixed colours, no single-mode accents, no legacy theme', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    // ACCENT's warn and crit are under AA as words in one mode or the other.
    expect(code).not.toMatch(/\bACCENT\b/);
    // The light-only legacy alias.
    expect(code).not.toMatch(/\btheme\./);
    // No hard-coded colour for words, fills or borders.
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    expect(code).not.toMatch(/rgba?\(/);
    // paper2 is the card colour in dark (a well on a card drew nothing); ink5
    // is decoration only.
    expect(code).not.toMatch(/\bc\.(paper2|ink5)\b/);
  });

  // Mutation caught: any word put back in c.ink4 (the SKU on a location row,
  // a procedure's "updated" line, a movement's meta line).
  it.each(FILES)('%s: the faint ink4 colours glyphs only, never words', (file) => {
    const code = codeOnly(sourceOf(file));
    const COLOUR_PROPS = new Set(['color', 'placeholderTextColor', 'tintColor']);
    const { sf, els } = elements(file, (el, s) =>
      (ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes).properties.some(
        (a) =>
          ts.isJsxAttribute(a) &&
          COLOUR_PROPS.has(a.name.getText(s)) &&
          (a.initializer?.getText(s) ?? '').includes('c.ink4'),
      ),
    );
    const allowed = new Set(['ChevronRight']);
    expect(
      els.filter((el) => !allowed.has(tagOf(el, sf))).map((el) => where(file, el, sf)),
    ).toEqual([]);
    // And none outside an attribute (a colour picked in a constant).
    expect((code.match(/\bc\.ink4\b/g) ?? []).length).toBe(els.length);
  });
});

/** The four lists that used to show their empty words over a failed read. */
const D25 = [
  {
    file: CATEGORIES,
    noun: 'categories',
    eyebrow: ['ORGANIZE · CATEGORIES', 'ORGANIZE · ${rows.length} CATEGORIES'],
    title: ['title="Categories"', 'italic="& taxonomies."'],
    empty: ['No categories yet.', 'Create categories on the web to organize items by type.'],
  },
  {
    file: TAGS,
    noun: 'tags',
    eyebrow: ['ORGANIZE · TAGS', 'ORGANIZE · ${rows.length} TAGS'],
    title: ['title="Tags"', 'italic="& flags."'],
    empty: [
      'No tags yet.',
      'Tag items on the web for ad-hoc grouping like clearance or watchlist.',
    ],
  },
  {
    file: PROCEDURES,
    noun: 'procedures',
    eyebrow: ['OPERATIONS · SOPS', 'OPERATIONS · ${rows.length} SOPS'],
    title: ['title="Standard"', 'italic="procedures."'],
    empty: [
      'No procedures yet.',
      'Write SOPs on the web — counting routines, intake checklists, packing rituals — and reference them from the floor here.',
    ],
  },
  {
    file: MOVEMENTS,
    noun: 'movements',
    eyebrow: ['ACTIVITY · EVENTS', 'ACTIVITY · ${rows.length} EVENTS'],
    title: ['title="Stock"', 'italic="movements."'],
    empty: [
      'No movements yet.',
      'Every receive, adjust, transfer, and count posts a row to the ledger here.',
    ],
  },
] as const;

describe('D25: a failed read is said, never shown as an empty list', () => {
  describe.each(D25)('$file', ({ file, noun, eyebrow, title, empty }) => {
    const code = flatCode(file);

    // Mutation caught: the screen's old `setRows(data ?? [])` (an error read
    // as no rows), and any branch of the rule changed.
    it("its own settleList: a failed read keeps this workspace's rows, never another's", () => {
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
      // A good read after a failed one clears the failure.
      const b = [{ id: 'a2' }];
      expect(settle(settle(read, 'org-a', null), 'org-a', b)).toEqual({
        orgId: 'org-a',
        rows: b,
        failed: false,
      });
    });

    it('a failed read lands through settleList, after the newest-read check', () => {
      expect(code).toContain('if (error) throw new Error(error.message);');
      expect(code).toMatch(
        /if \(!orgId\) return; const seq = \+\+seqRef\.current; let rows: \w+\[\] \| null = null; try \{/,
      );
      expect(code).toMatch(
        /\} catch \(e\) \{ console\.warn\('\[\w+\] load failed:', e instanceof Error \? e\.message : e\); \} if \(seq !== seqRef\.current\) return; setStored\(\(prev\) => settleList\(prev, orgId, rows\)\); \}, \[orgId\]\);/,
      );
      // Only the workspace on screen.
      expect(code).toContain('const list = stored && stored.orgId === orgId ? stored : null;');
    });

    // Mutation caught: failed left off (the empty words over a failure), the
    // words swapped into emptyTitle, or the workspace case dropped.
    it('passes DataListScreen its own failure words; the empty words are only the empty words', () => {
      expect(code).toContain(
        `failed={ noWorkspace ? { title: 'Could not load your workspace.', body: 'Check your connection and pull down to try again.', } : list?.failed ? { title: 'Could not load ${noun}.', body: 'Check your connection and pull down to try again.', reloadNote: 'Could not refresh the ${noun}. Pull down to try again.', } : null }`,
      );
      expect(code).toContain(`emptyTitle="${empty[0]}"`);
      expect(code).toContain(`emptyBody="${empty[1]}"`);
      for (const t of title) expect(code).toContain(t);
    });

    // The screen used to spin for good with no workspace (the read never
    // starts): it now says so, and a pull loads the workspace again.
    it('with no workspace: the failure, and a pull that loads the workspace again', () => {
      expect(code).toContain('const { orgId, loading: workspaceLoading } = useOrg();');
      expect(code).toContain('const noWorkspace = !orgId && !workspaceLoading;');
      expect(code).toContain("import { retryWorkspace } from '@/lib/use-workspace';");
      expect(code).toContain(
        'async function refresh() { setRefreshing(true); try { await (noWorkspace ? retryWorkspace() : load()); } finally { setRefreshing(false); } }',
      );
      expect(code).toContain('loading={!noWorkspace && list === null}');
      expect(code).toContain('onRefresh={() => void refresh()}');
    });

    // An eyebrow count from a read that has not answered, or failed, would be
    // a claim ("0 CATEGORIES"); it shows only for rows the screen read.
    it('the eyebrow quotes a count only for a list it read', () => {
      expect(code).toContain(
        'const failedEmpty = noWorkspace || (list !== null && list.failed && rows.length === 0);',
      );
      const rule = `list === null || failedEmpty ? '${eyebrow[0]}' : \`${eyebrow[1]}\``;
      expect(code).toMatch(new RegExp(`eyebrow=\\{\\s*${escapeRe(rule)}\\s*\\}`));
    });
  });
});

describe('Locations list', () => {
  const code = flatCode(LOCATIONS);

  it('the refresh notice is the per-mode warning tone, announced; the ceiling note muted', () => {
    expect(code).toContain(
      "<Body size={12.5} color={error ? c.warnText : undefined} muted={!error} accessibilityRole={error ? 'alert' : undefined} >",
    );
    expect(code).toContain("'Could not refresh the locations. Pull down to try again.'");
    expect(code).toContain('LOCATIONS_LIST_CEILING_COPY');
  });

  it('no count in the eyebrow before the list is read', () => {
    expect(code).toContain(
      "eyebrow={ list === null || failedEmpty ? 'WAREHOUSE · LOCATIONS' : `WAREHOUSE · ${rows.length} LOCATIONS` }",
    );
  });

  it('a row: the pin in a recessed well, its words, the type pill and the chevron', () => {
    const fn = code.slice(code.indexOf('function LocationCard('));
    expect(fn).toContain('backgroundColor: c.sunk');
    expect(fn).toContain('<MapPin size={16} color={c.ink} strokeWidth={1.5} />');
    expect(fn).toContain('{loc.type ? <Pill>{loc.type.toUpperCase()}</Pill> : null}');
    expect(fn).toContain('accessibilityRole="button" accessibilityHint="Opens the location"');
  });
});

describe('rows that open something are buttons to VoiceOver', () => {
  // Mutation caught: the role or the hint dropped from any of them (the
  // Procedures and Movements rows had no role before this package).
  it.each([
    [PROCEDURES, 'openOnWeb', 'Opens the procedure on the web'],
    [MOVEMENTS, 'onPress', 'Opens the item'],
    [LOCATIONS, 'onPress', 'Opens the location'],
  ])('%s: the row (onPress={%s}) is a button that says where it goes', (file, press, hint) => {
    const { sf, els } = elements(
      file,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === press,
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!, 'accessibilityHint', sf)).toBe(hint);
  });

  it.each([PROCEDURES, MOVEMENTS, LOCATIONS])(
    '%s: every touchable has a role and words',
    (file) => {
      const { sf, els } = elements(file, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) {
        expect(attrText(el, 'accessibilityRole', sf), where(file, el, sf)).toBe('button');
      }
    },
  );
});

describe('Procedures and Movements keep every word', () => {
  it('a procedure: its title, description, "updated" day and category pill; it opens the web page', () => {
    const code = flatCode(PROCEDURES);
    expect(code).toContain(
      'Linking.openURL(`https://stockpilotusa.com/dashboard/procedures/${proc.id}`)',
    );
    expect(code).toContain(
      "<Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 8 }}> updated{' '} {new Date(proc.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', })} </Mono>",
    );
    expect(code).toContain(
      '{proc.category?.name ? <Pill>{proc.category.name.toUpperCase()}</Pill> : null}',
    );
    expect(code).toContain('.limit(100)');
  });

  it('a movement: the verb, the resolved reason, who, the signed change and the day; the colours repeat the sign', () => {
    const code = flatCode(MOVEMENTS);
    for (const w of [
      "add: 'Added'",
      "remove: 'Removed'",
      "adjust: 'Adjusted'",
      "transfer: 'Transferred'",
      "receive_po: 'Received'",
      "return: 'Returned'",
      "damage: 'Damaged'",
      "loss: 'Lost'",
      "correction: 'Corrected'",
      "initial: 'Initialized'",
    ]) {
      expect(code).toContain(w);
    }
    expect(code).toContain("{m.item?.name ?? 'Unknown item'}");
    expect(code).toContain(
      "<Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 3 }}> {verb} {m.reason ? ` · ${m.reason}` : ''} {' · '} {actor} </Mono>",
    );
    expect(code).toContain(
      'const pipColor = isAdd ? c.accent : m.quantity_change < 0 ? c.critText : c.warnText;',
    );
    expect(code).toContain(
      "color={isAdd ? c.accent : m.quantity_change < 0 ? c.critText : c.ink} > {isAdd ? '+' : ''} {m.quantity_change} </Mono>",
    );
    // The batched reference lookups and the ledger read are unchanged.
    expect(code).toContain(
      'resolveMovementRefReason((r.reason as string | null) ?? null, refLabelById)',
    );
    expect(code).toContain("router.push({ pathname: '/item/[id]', params: { id: m.item_id } })");
  });

  it('categories and tags: a colourless swatch is the muted ink3 mark; the tally dash stays', () => {
    // A stored colour is drawn only in the #rrggbb form the app writes; any
    // other text draws the same mark as no colour (docket T14).
    expect(flatCode(CATEGORIES)).toContain(
      'const swatch = safeHexColor(category.color) ?? c.ink3;',
    );
    expect(flatCode(CATEGORIES)).toContain("{category.itemCount ?? '—'}");
    expect(flatCode(CATEGORIES)).toContain('backgroundColor: c.sunk');
    expect(flatCode(TAGS)).toContain('const swatch = safeHexColor(tag.color) ?? c.ink3;');
    expect(flatCode(TAGS)).toContain('borderColor: c.hair2');
  });
});

describe('Movements: the ledger is one surface of hairline rows (M-SG-08)', () => {
  const code = flatCode(MOVEMENTS);

  // Mutation caught: a card per movement again (the layout before this
  // package's review), or the whole ledger folded into one list item, which
  // would no longer be virtualised.
  it('one row per movement, never a card per movement', () => {
    expect(code).not.toMatch(/<Card\b/);
    expect(code).not.toContain("from '@/components/ui/card'");
    expect(code).toContain('data={rows}');
    expect(code).toContain(
      "renderItem={(m, i) => ( <LedgerRow m={m} first={i === 0} last={i === rows.length - 1} onPress={() => router.push({ pathname: '/item/[id]', params: { id: m.item_id } })} /> )}",
    );
  });

  // Mutation caught: a row that is its own box again (every edge and corner
  // on every row), the separator or a side dropped, a fixed height, or the
  // pressed row no longer recessed.
  it('a row: the card fill, hairline sides and separator, 10 x 12 padding, 44pt or more', () => {
    const row = styleBlockOf(sourceOf(MOVEMENTS), 'row', MOVEMENTS);
    for (const decl of [
      'minHeight: 44,',
      'paddingVertical: 10,',
      'paddingHorizontal: 12,',
      'gap: 10,',
      'borderLeftWidth: 1,',
      'borderRightWidth: 1,',
      'borderBottomWidth: 1,',
    ]) {
      expect(row, decl).toContain(decl);
    }
    expect(row).not.toMatch(/\bheight:/);
    expect(code).toContain(
      'style={({ pressed }) => [ styles.row, { backgroundColor: pressed ? c.sunk : c.card, borderColor: c.hair, borderTopWidth: first ? 1 : 0, borderTopLeftRadius: first ? LIST_RADIUS : 0, borderTopRightRadius: first ? LIST_RADIUS : 0, borderBottomLeftRadius: last ? LIST_RADIUS : 0, borderBottomRightRadius: last ? LIST_RADIUS : 0, marginBottom: last ? 0 : -LIST_GAP, }, ]}',
    );
    // The surface's corners: 14, the reference's phone list.
    expect(code).toContain('const LIST_RADIUS = RADIUS.cardHero;');
    expect(RADIUS.cardHero).toBe(14);
  });

  // The rows meet only while LIST_GAP is the gap DataListScreen sets between
  // a list's rows. Mutation caught: either number changed alone (rows drawn
  // over each other, or apart again with open edges).
  it("the rows meet: each but the last takes back DataListScreen's list gap", () => {
    expect(code).toContain('const LIST_GAP = 10;');
    const shared = 'src/components/data-list-screen.tsx';
    expect(styleBlockOf(sourceOf(shared), 'list', shared)).toMatch(/\bgap: 10,/);
  });
});

describe('Location screen', () => {
  const code = flatCode(LOCATION);

  it('warnings and refusals in the per-mode tones; the SKU muted ink3', () => {
    expect(code).toContain(
      '<Body size={13} color={c.warnText} style={{ marginTop: 6 }}> {LOCATION_HOLDINGS_TRUNCATED_COPY} </Body>',
    );
    expect(code).toContain(
      '<Body size={13} color={c.critText} accessibilityRole="alert"> {gather.message} </Body>',
    );
    expect(code).toContain(
      '<Body size={13.5} color={unavailable ? c.warnText : c.ink}> {copy.count} </Body>',
    );
    expect(code).toContain(
      '<Body key={issue.id} size={12.5} color={c.warnText}> {chips[i]} </Body>',
    );
    expect(code).toContain(
      '<Mono size={11.5} color={c.ink3} style={{ marginTop: 2 }}> {row.sku} </Mono>',
    );
  });

  it('the loading spinner keeps its spoken name', () => {
    expect(code).toContain('accessibilityLabel="Loading this location"');
  });
});

/**
 * WCAG contrast of every word and mark these screens draw, in both modes,
 * from the palette (AA: 4.5:1 for words, 3:1 for glyphs and marks).
 */
describe('contrast, both modes', () => {
  const WORDS: [keyof Palette, keyof Palette, string][] = [
    ['ink', 'card', 'names on the cards'],
    ['ink3', 'card', 'meta lines, descriptions, SKUs'],
    ['ink3', 'paper', 'eyebrows, the ceiling note, the loading spinner'],
    ['warnText', 'paper', 'the refresh-failure notice'],
    ['warnText', 'card', 'location truncation, unavailable count and issue lines'],
    ['critText', 'card', 'the gather failure, a stock-out quantity'],
    ['accent', 'card', 'a stock-in quantity'],
    ['ink', 'sunk', "a pressed movement row's item name"],
    ['ink3', 'sunk', "a pressed movement row's meta line and day"],
    ['accent', 'sunk', "a pressed movement row's stock-in quantity"],
    ['critText', 'sunk', "a pressed movement row's stock-out quantity"],
  ];
  const MARKS: [keyof Palette, keyof Palette, string][] = [
    ['ink3', 'sunk', 'a colourless category swatch'],
    ['ink3', 'card', 'a colourless tag swatch'],
    ['accent', 'sunk', 'the stock-in pip'],
    ['critText', 'sunk', 'the stock-out pip'],
    ['warnText', 'sunk', 'the no-change pip'],
    ['ink', 'sunk', 'the row glyphs in their wells'],
    ['ink4', 'card', 'the chevrons'],
  ];

  it.each(MODES)('%s: words at 4.5:1 or more', (_mode, c) => {
    for (const [fg, bg, what] of WORDS) {
      expect(contrast(c[fg], c[bg]), `${fg} on ${bg}: ${what}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(MODES)('%s: marks at 3:1 or more', (_mode, c) => {
    for (const [fg, bg, what] of MARKS) {
      expect(contrast(c[fg], c[bg]), `${fg} on ${bg}: ${what}`).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  // Mutation caught: a word drawn in a token that is not a text colour (a
  // hairline, the faint ink5, the card colour).
  it('every colour these screens give words or glyphs is a text token of the palette', () => {
    const TEXT_TOKENS = new Set(['accent', 'critText', 'ink', 'ink3', 'ink4', 'warnText']);
    for (const file of FILES) {
      for (const m of codeOnly(sourceOf(file)).matchAll(/\bcolor=\{[^}]*\}/g)) {
        for (const t of m[0].matchAll(/\bc\.(\w+)/g)) {
          expect(TEXT_TOKENS.has(t[1]!), `${file}: ${m[0]}`).toBe(true);
        }
      }
    }
  });
});
