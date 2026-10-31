import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { pillTone, type PillStatus } from '../components/ui/tones';
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
import {
  ITEM_TAB_WIDEST_LABEL_EM,
  itemTabLabelRoom,
  itemTabLabelSize,
  itemTabStackedLabelRoom,
} from './dynamic-type-layout';
import { SERIAL_STATUSES } from './serials';
import { TYPE_CEILING, capTo, palette, type Palette } from './theme';

/**
 * THE PHONE ITEM SCREENS AND STOCK SHEETS, READ AS SOURCE (redesign package
 * P5.6, matrix rows M-IN-05, 05a-05f and 06).
 *
 * The item screen (app/item/[id].tsx), the New item / New book form
 * (app/item/new.tsx), and the sheets and cards they open (Move stock / Put
 * away, Remove from rack, the recount sheet, the item history sheet, the last
 * physical count card and the photo viewer) took the redesign look on the
 * per-mode palette. The look is all that moved. These pin what had to survive
 * it: every word, spoken name, role and state, the gates and the helper each
 * one uses, the never-optimistic stock and the offline queue's words, the
 * uncontrolled rack boxes, the measured footer, each sheet's sibling scrim,
 * the 44pt targets, the Dynamic Type caps, and the colours, measured in both
 * modes against the palette they come from.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, as scanner-structure.test.ts and
 * sheet-a11y-structure.test.ts read theirs.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const ITEM = 'app/item/[id].tsx';
const NEW_ITEM = 'app/item/new.tsx';
const MOVE = 'src/components/move-stock-modal.tsx';
const REMOVE = 'src/components/remove-from-rack-modal.tsx';
const RECOUNT = 'src/components/exception-recount-sheet.tsx';
const HISTORY = 'src/components/item-history-sheet.tsx';
const CARD = 'src/components/item-verification-card.tsx';
const VIEWER = 'src/components/photo-viewer.tsx';
const SHIM = 'app/dashboard/inventory/[id].tsx';

/** Every file this package restyled. */
const OWNED = [ITEM, NEW_ITEM, MOVE, REMOVE, RECOUNT, HISTORY, CARD, VIEWER];

/** The 44pt rule, as the screens spell it. */
const MIN_TAP_PT = 44;

const LIGHT = palette('light');
const DARK = palette('dark');
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
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

/** One whitespace run per gap, so a reformat cannot break a pin. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ');
}

/** The declaration `function name(...) {...}` of a file. */
function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

type Found = { el: JsxNode; ancestors: JsxNode[]; sf: ts.SourceFile; file: string };

/** Every element of a file (or of one node in it) that matches. */
function elements(
  file: string,
  match: (el: JsxNode, sf: ts.SourceFile) => boolean,
  within?: (sf: ts.SourceFile) => ts.Node,
): Found[] {
  const sf = treeOf(file);
  const out: Found[] = [];
  walkJsx(within ? within(sf) : sf, (el, ancestors) => {
    if (match(el, sf)) out.push({ el, ancestors: [...ancestors], sf, file });
  });
  return out;
}

function where(f: Found): string {
  const { line } = f.sf.getLineAndCharacterOfPosition(f.el.getStart(f.sf));
  return `${f.file}:${line + 1} <${tagOf(f.el, f.sf)}>`;
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).replace(/\s+/g, ' ').trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/**
 * Everything a person can read or hear in a file: JSX text and every string
 * and template literal (comments are not literals, so they never count).
 */
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

function jsxChildren(el: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(el)) return [];
  return el.children.filter(
    (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
  );
}

/** A style written inline, as one line of source (`{{ a: 1 }}` or a callback). */
function styleOf(f: Found): string {
  return flat(attrText(f.el, 'style', f.sf) ?? '');
}

/** The body of `name: { ... }` inside a file's StyleSheet, as one line. */
function styleBlock(file: string, name: string): string {
  const src = sourceOf(file);
  const m = new RegExp(`\\n  ${name}: \\{([^}]*)\\}`).exec(src);
  expect(m, `${file} has no style ${name}`).not.toBeNull();
  return flat(codeOnly(m![1]!));
}

// ── Every word, name and role survives ───────────────────────────────────

describe('the item screen keeps every word', () => {
  const words = wordsOf(ITEM);
  it.each([
    'ARCHIVED',
    'AUTO-ARCHIVED',
    'EXPECTED — AWAITING FIRST RECEIPT',
    'The system archived this item automatically after it sat at zero stock past the configured dwell window.',
    'Created from a purchase order — hidden from the default Items list until the first units are received. It appears automatically the moment any stock arrives.',
    'Restoring…',
    'Restore',
    'View photo',
    'Add photo',
    'Tap to add photo',
    'Replace photo',
    'Replace',
    'Take photo',
    'Choose from library',
    'Overview',
    'Movements',
    'Activity',
    'ON HAND',
    'OK',
    'LOW',
    'OUT',
    'Reorder at',
    '· suggested reorder',
    '−5',
    '−1',
    '+1',
    '+5',
    'Adjust with reason',
    'Transfer / put away',
    'Remove from rack',
    'Report a problem',
    'This placement only — on-hand adjustments here apply just to this rack/charter, not other placements of this SKU.',
    'UNIT COST',
    'RETAIL PRICE',
    'INVENTORY VALUE',
    'SUPPLIER',
    'Shared across all placements of this SKU — name, SKU, cost, price, and category update everywhere this item lives when edited on web.',
    'This placement only — describes just this rack/charter, not other placements of this SKU.',
    'DESCRIPTION',
    'Edit on web',
    'No movements',
    'No activity',
    'yet.',
    'Adjustments, receipts, and counts will appear here as you work.',
    'Edits, archive/restore, serials, tags, and stock changes will appear here as you work.',
    'Edit note',
    'Add note',
    'EDIT NOTE',
    'ADD NOTE',
    'Notes are the only editable field on a movement — every change is recorded in the audit log.',
    'Add context for this movement…',
    'Saving…',
    'Save',
    'Cancel',
    'Fields on the edit (exact changes not recorded for this entry):',
    'ADJUST STOCK',
    'on hand',
    ' · not confirmed',
    ' queued offline',
    'CHANGE (+ ADDS, − REMOVES)',
    'e.g. -3 or 12',
    'REASON (OPTIONAL)',
    'Cycle count variance, damage, etc.',
    'NEW TOTAL',
    'Confirm',
    'Mobile detail',
    'Not confirmed · may still be saving',
    'Not confirmed · pull down to refresh',
    'Queued offline · ',
    ' · sends when online',
    'SERIALS',
    'Add serials',
    'No serials recorded yet.',
    ' Use “Add serials” to register units manually.',
    'Tap a serial to change status · long-press to delete manual entries',
    'SET STATUS',
    'Current',
    'ADD SERIALS',
    'SERIAL NUMBERS (ONE PER LINE)',
    'SN-0001\nSN-0002',
    'WAREHOUSE',
    'No active warehouses — create one before adding serials.',
    'Adding…',
    'Delete serial?',
    'From PO receipt — change status instead.',
    'Could not load this item',
    'Not found',
    'This item no longer exists.',
    'Could not restore',
  ])('says "%s"', (word) => {
    expect(words).toContain(word);
  });

  it('the core words for grouping, counting and the shared SKU still come from core', () => {
    const code = codeOnly(sourceOf(ITEM));
    for (const piece of [
      'GROUP_COPY.itemPageInGroup(displayGroup.name ?? DISPLAY_GROUP_FALLBACK_NAME)',
      '{GROUP_COPY.removeAction}',
      'sharedSkuNoteCopy(skuSiblings, item.sku)',
      '{GROUPING_ERROR_WORDS.kit}',
      '{GROUPING_ERROR_WORDS.family}',
      '{UNGROUP_COPY.makeOwnItem}',
      '{COUNT_THIS_ITEM_LABEL}',
    ]) {
      expect(code).toContain(piece);
    }
  });
});

describe('the New item form keeps every word', () => {
  const words = wordsOf(NEW_ITEM);
  it.each([
    'Scan instead',
    'NEW',
    'BOOK',
    'ITEM',
    'Add',
    'a book.',
    'an item.',
    'PHOTOS',
    'CAMERA',
    'LIBRARY',
    'BASICS',
    'TITLE',
    'NAME',
    'A Brief History of Time',
    'Wireless mouse',
    'SKU',
    'Auto',
    'SP-AB1234',
    'ISBN',
    'BARCODE',
    'AUTHOR',
    'MODEL NUMBER',
    'DESCRIPTION',
    'Optional notes',
    'CLASSIFICATION',
    'CATEGORY',
    'SUPPLIER',
    'No suppliers yet.',
    'LOCATION',
    'WAREHOUSE',
    'CHARTER',
    'No charters configured.',
    'Generic',
    'PRIMARY LOCATION',
    'No locations yet.',
    'RACK NUMBER',
    'RACK ROW',
    'DETAILS',
    'Optional, but they are what group this style with the same style added anywhere else.',
    'HOME / AWAY',
    'Unset',
    'Home',
    'Away',
    'Alternate',
    'SIZES & QUANTITIES',
    'This category has no size scale yet. Saving creates one item.',
    'One item per size will be created. Leave a size at 0 to skip it.',
    'VARIANT',
    'Required for',
    'SIZE',
    'Size, required',
    'SIZE SYSTEM',
    'JERSEY NUMBER',
    'Jersey number, required',
    'PRICING & STOCK',
    'UNIT COST',
    'RETAIL PRICE',
    'ON HAND',
    'REORDER AT',
    'REORDER QTY',
    'UNIT OF MEASURE',
    'Create book',
    'Create item',
    'Sizes are still loading',
    'Pick at least one size',
    'Check the form',
    'Variants created',
    'Item created',
    'Create rack and save',
    'Save anyway',
    'Camera access needed',
    'Photo access needed',
    'Not signed in',
  ])('says "%s"', (word) => {
    expect(words).toContain(word);
  });
});

describe('the sheets and cards keep every word', () => {
  it.each([
    [
      MOVE,
      [
        'PUT AWAY',
        'MOVE STOCK',
        'FROM',
        'PLACE INTO',
        'RACK NUMBER',
        'ROW',
        'CRATE COLOR',
        'CRATE NUMBER',
        'RACK NUMBER *',
        'ROW (OPTIONAL)',
        '+ New rack…',
        'QUANTITY',
        'NOTES (OPTIONAL)',
        'Why is this stock moving?',
        'Cancel',
        'Moving…',
        'Put away',
        'Move stock',
        'Create and put away',
        'Could not move stock',
        'TO RACK, CRATE, OR UNPLACED — TAP TO FILL IN',
        'TO RACK, CRATE, OR UNPLACED',
        'TO RACK / CRATE — TAP TO FILL IN',
        'TO RACK / CRATE',
      ],
    ],
    [
      REMOVE,
      [
        'REMOVE FROM RACK',
        'RACK / CRATE',
        'QUANTITY TO REMOVE',
        'REASON *',
        'e.g. Damaged in storage, cycle-count correction',
        'Cancel',
        'Removing…',
        'Remove stock',
        'in this rack.',
      ],
    ],
    [
      RECOUNT,
      [
        'Recount',
        'Open the count',
        'Done',
        'ASSIGN TO (OPTIONAL)',
        'Unassigned',
        'The assignee gets a notification to start the count.',
        'Try again',
        'Starting...',
        'Start recount',
        'Checking this item’s open exceptions...',
      ],
    ],
    [
      HISTORY,
      [
        'HISTORY',
        'Try again.',
        'No stock movements recorded for this item.',
        'Loading…',
        'Load older movements',
        'Try again',
        'WHO',
        'EMAIL',
        'WHERE',
        'ON HAND',
        'WHY',
        'SOURCE',
      ],
    ],
    [
      CARD,
      [
        'LAST PHYSICAL COUNT',
        'Loading the last physical count',
        'Loading...',
        'Trying again...',
        'Try again',
        'OPEN EXCEPTIONS',
        'Opens the count',
        "Shows the item's movements",
        'Opens the exception',
      ],
    ],
    [VIEWER, ['Photo — tap to close', 'Close photo viewer']],
  ])('%s', (file, expected) => {
    const words = wordsOf(file);
    for (const word of expected) expect(words, `${file} lost "${word}"`).toContain(word);
  });
});

// ── Names, roles and states ──────────────────────────────────────────────

describe('item screen: every control is named, with its role and state', () => {
  const touch = (pred: (f: Found) => boolean) =>
    elements(ITEM, (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf))).filter(pred);

  it('Back and Edit item are the named 44pt header chips', () => {
    const chips = elements(ITEM, (el, sf) => tagOf(el, sf) === 'IconChip');
    expect(chips.map((c) => attrText(c.el, 'accessibilityLabel', c.sf))).toEqual([
      'Back',
      'Edit item',
    ]);
    for (const c of chips) expect(attrText(c.el, 'minTap', c.sf)).toBe('true');
  });

  // Mutation caught: the tabs back to bare Pressables (no role, no state).
  it('the three tabs are tabs that say which one is open, on a tablist track', () => {
    const tab = elements(
      ITEM,
      (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)),
      (sf) => functionNamed(sf, 'TabButton'),
    );
    expect(tab).toHaveLength(1);
    expect(attrText(tab[0]!.el, 'accessibilityRole', tab[0]!.sf)).toBe('tab');
    expect(attrText(tab[0]!.el, 'accessibilityState', tab[0]!.sf)).toBe('{ selected: active }');
    const tracks = elements(ITEM, (el, sf) => attrText(el, 'accessibilityRole', sf) === 'tablist');
    expect(tracks).toHaveLength(1);
    expect(jsxChildren(tracks[0]!.el).map((ch) => tagOf(ch, tracks[0]!.sf))).toEqual([
      'TabButton',
      'TabButton',
      'TabButton',
    ]);
    expect(jsxChildren(tracks[0]!.el).map((ch) => attrText(ch, 'label', tracks[0]!.sf))).toEqual([
      'Overview',
      'Movements',
      'Activity',
    ]);
  });

  it('the photo tile, Replace and Edit on web say what they are', () => {
    const tile = touch(
      (f) =>
        attrText(f.el, 'accessibilityLabel', f.sf) === "item.imageUrl ? 'View photo' : 'Add photo'",
    );
    expect(tile).toHaveLength(1);
    expect(attrText(tile[0]!.el, 'accessibilityRole', tile[0]!.sf)).toBe('button');
    const replace = touch((f) => attrText(f.el, 'accessibilityLabel', f.sf) === 'Replace photo');
    expect(replace).toHaveLength(1);
    expect(attrText(replace[0]!.el, 'accessibilityRole', replace[0]!.sf)).toBe('button');
    expect(attrText(replace[0]!.el, 'hitSlop', replace[0]!.sf)).toBeUndefined();
    const web = touch((f) => attrText(f.el, 'onPress', f.sf) === 'openEdit');
    expect(web).toHaveLength(1);
    expect(attrText(web[0]!.el, 'accessibilityRole', web[0]!.sf)).toBe('link');
    expect(textOf(web[0]!.el, web[0]!.sf)).toBe('Edit on web');
  });

  it('the quick steps, Load more and the note link are buttons', () => {
    for (const fn of ['QuickBtn', 'LoadMoreFooter']) {
      const t = elements(
        ITEM,
        (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)),
        (sf) => functionNamed(sf, fn),
      );
      expect(t, fn).toHaveLength(1);
      expect(attrText(t[0]!.el, 'accessibilityRole', t[0]!.sf), fn).toBe('button');
    }
    const note = touch((f) => attrText(f.el, 'onPress', f.sf) === '() => setNoteOpen(true)');
    expect(note).toHaveLength(1);
    expect(attrText(note[0]!.el, 'accessibilityRole', note[0]!.sf)).toBe('button');
    expect(attrText(note[0]!.el, 'accessibilityLabel', note[0]!.sf)).toBe(
      "movement.notes ? 'Edit note' : 'Add note'",
    );
  });

  it('serial rows, the status picker and the warehouse choices keep their names and say what is chosen', () => {
    const rows = touch((f) =>
      (attrText(f.el, 'accessibilityLabel', f.sf) ?? '').startsWith('`Serial ${row.serial_number}'),
    );
    expect(rows).toHaveLength(1);
    expect(attrText(rows[0]!.el, 'accessibilityRole', rows[0]!.sf)).toBe(
      "canWrite ? 'button' : undefined",
    );
    expect(attrText(rows[0]!.el, 'onLongPress', rows[0]!.sf)).toBe(
      'canWrite && !mutatingId ? () => confirmDelete(row) : undefined',
    );
    const status = touch(
      (f) =>
        attrText(f.el, 'accessibilityLabel', f.sf) === '`Set status ${SERIAL_STATUS_LABELS[s]}`',
    );
    expect(status).toHaveLength(1);
    expect(attrText(status[0]!.el, 'accessibilityRole', status[0]!.sf)).toBe('button');
    // The name replaces the row's words, so the current status is a state.
    expect(attrText(status[0]!.el, 'accessibilityState', status[0]!.sf)).toBe(
      '{ selected: current }',
    );
    const wh = touch((f) => attrText(f.el, 'accessibilityLabel', f.sf) === '`Warehouse ${w.name}`');
    expect(wh).toHaveLength(1);
    expect(attrText(wh[0]!.el, 'accessibilityState', wh[0]!.sf)).toBe('{ selected }');
  });

  it('every typed box in the sheets is named for VoiceOver', () => {
    const inputs = elements(ITEM, (el, sf) => tagOf(el, sf) === 'TextInput');
    expect(inputs.map((i) => attrText(i.el, 'accessibilityLabel', i.sf))).toEqual([
      // The note box: the ADD NOTE / EDIT NOTE eyebrow is a separate element
      // and the placeholder is read only while the box is empty, so EDIT
      // NOTE's existing note needs a name of its own.
      'Note',
      'Change, plus adds, minus removes',
      'Reason, optional',
      'Serial numbers, one per line',
    ]);
  });
});

describe('New item form: every control is named, with its role and state', () => {
  const touch = (pred: (f: Found) => boolean) =>
    elements(NEW_ITEM, (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf))).filter(pred);

  it('every touchable is a button with words or a name, and none borrows hitSlop', () => {
    const all = touch(() => true);
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const t of all) {
      expect(attrText(t.el, 'accessibilityRole', t.sf), where(t)).toBe('button');
      const named =
        attrText(t.el, 'accessibilityLabel', t.sf) !== undefined || textOf(t.el, t.sf) !== '';
      expect(named, `${where(t)} has nothing for VoiceOver to read`).toBe(true);
      expect(attrText(t.el, 'hitSlop', t.sf), where(t)).toBeUndefined();
    }
  });

  // Mutation caught: a staged photo's X back to an unnamed 20pt circle.
  it("a staged photo's remove X is named, in a 44pt frame", () => {
    const x = touch((f) => attrText(f.el, 'onPress', f.sf) === '() => onRemove(idx)');
    expect(x).toHaveLength(1);
    expect(attrText(x[0]!.el, 'accessibilityLabel', x[0]!.sf)).toBe('`Remove photo ${idx + 1}`');
    expect(flat(sourceOf(NEW_ITEM))).toMatch(
      /photoRemoveFrame: \{ position: 'absolute', top: 0, right: 0, width: MIN_TAP, height: MIN_TAP,/,
    );
  });

  it('every choice chip says whether it is chosen, and the size systems keep their names', () => {
    const chip = elements(
      NEW_ITEM,
      (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)),
      (sf) => functionNamed(sf, 'ChoiceChip'),
    );
    expect(chip).toHaveLength(1);
    expect(attrText(chip[0]!.el, 'accessibilityState', chip[0]!.sf)).toBe('{ selected }');
    expect(attrText(chip[0]!.el, 'accessibilityLabel', chip[0]!.sf)).toBe('accessibilityLabel');
    // Every chip on the form is a ChoiceChip: no hand-drawn chip is left.
    // Warehouse, home / away, size system, and the picker's clear and options
    // (category, supplier, charter and primary location).
    const uses = elements(NEW_ITEM, (el, sf) => tagOf(el, sf) === 'ChoiceChip');
    expect(uses.length).toBe(5);
    const sizeSystem = uses.find((u) => attrText(u.el, 'accessibilityLabel', u.sf) !== undefined);
    expect(sizeSystem && attrText(sizeSystem.el, 'accessibilityLabel', sizeSystem.sf)).toBe(
      '`Size system: ${SIZE_SYSTEM_LABELS[sys]}`',
    );
  });

  it("every typed box is named for VoiceOver with its label's words", () => {
    const boxes = elements(NEW_ITEM, (el, sf) => tagOf(el, sf) === 'BoxInput');
    expect(boxes.map((b) => attrText(b.el, 'accessibilityLabel', b.sf))).toEqual([
      "isBook ? 'Title' : 'Name'",
      'SKU',
      "isBook ? 'ISBN' : 'Barcode'",
      "isBook ? 'Author' : 'Model number'",
      'Description',
      'Rack number',
      'Rack row',
      'f.label',
      '`${sz} quantity`',
      'Size, required',
      'Jersey number, required',
      'Unit cost',
      'Retail price',
      'On hand',
      'Reorder at',
      'Reorder quantity',
      'Unit of measure',
    ]);
  });

  it('Create is the shared ink Button (a button to VoiceOver), keeping its words while it saves', () => {
    const create = elements(NEW_ITEM, (el, sf) => tagOf(el, sf) === 'Button');
    expect(create).toHaveLength(1);
    const c = create[0]!;
    expect(attrText(c.el, 'variant', c.sf)).toBeUndefined(); // primary: the ink fill
    expect(attrText(c.el, 'onPress', c.sf)).toBe('save');
    expect(attrText(c.el, 'disabled', c.sf)).toBe('busy');
    expect(flat(c.el.getText(c.sf))).toContain("{isBook ? 'Create book' : 'Create item'}");
    expect(attrText(c.el, 'leading', c.sf)).toBe(
      'busy ? <ActivityIndicator color={c.paper} /> : undefined',
    );
  });

  it('Scan instead and Back keep their names', () => {
    expect(
      elements(NEW_ITEM, (el, sf) => tagOf(el, sf) === 'IconChip').map((c) =>
        attrText(c.el, 'accessibilityLabel', c.sf),
      ),
    ).toEqual(['Back']);
    const scan = touch((f) => attrText(f.el, 'accessibilityLabel', f.sf) === 'Scan instead');
    expect(scan).toHaveLength(1);
    expect(attrText(scan[0]!.el, 'onPress', scan[0]!.sf)).toBe("() => router.push('/scan')");
  });
});

describe('sheets and cards: names, roles and states', () => {
  it('the move and remove sheets name their boxes', () => {
    expect(
      elements(MOVE, (el, sf) => tagOf(el, sf) === 'TextInput').map((i) =>
        attrText(i.el, 'accessibilityLabel', i.sf),
      ),
    ).toEqual(['label', 'Quantity', 'Notes, optional']);
    expect(
      elements(REMOVE, (el, sf) => tagOf(el, sf) === 'TextInput').map((i) =>
        attrText(i.el, 'accessibilityLabel', i.sf),
      ),
    ).toEqual(['Quantity to remove', 'Reason, required']);
  });

  it("Remove from rack's holdings are the shared chip (no chip declared inside the render)", () => {
    const sf = treeOf(REMOVE);
    const content = functionNamed(sf, 'RemoveFromRackContent');
    // A component (a capitalised function) declared inside the render is a
    // new component every render: its subtree remounts each time.
    const nested: string[] = [];
    const visit = (n: ts.Node) => {
      if (n !== content && ts.isFunctionDeclaration(n) && /^[A-Z]/.test(n.name?.text ?? '')) {
        nested.push(n.name!.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(content);
    expect(nested).toEqual([]);
    // The holdings are the move sheet's module-level 44pt chip.
    expect(sourceOf(REMOVE)).toContain(
      "import { SheetChip } from '@/components/move-stock-modal';",
    );
    expect(elements(REMOVE, (el, s) => tagOf(el, s) === 'SheetChip')).toHaveLength(1);
    expect(elements(REMOVE, (el, s) => tagOf(el, s) === 'Chip')).toHaveLength(0);
  });

  it('the recount choices are radios that say which is chosen, with a mark beside the colour', () => {
    const radio = elements(
      RECOUNT,
      (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)),
      (sf) => functionNamed(sf, 'MemberOption'),
    );
    expect(radio).toHaveLength(1);
    expect(attrText(radio[0]!.el, 'accessibilityRole', radio[0]!.sf)).toBe('radio');
    expect(attrText(radio[0]!.el, 'accessibilityState', radio[0]!.sf)).toBe('{ selected }');
    expect(codeOnly(sourceOf(RECOUNT))).toContain('const Mark = selected ? CircleDot : Circle;');
    const links = elements(RECOUNT, (el, sf) => attrText(el, 'accessibilityRole', sf) === 'link');
    expect(links).toHaveLength(1);
  });

  // Mutation caught: an X with no name or role (VoiceOver found an icon only).
  it.each([RECOUNT, HISTORY])(
    '%s: the X is a named button, a 44pt frame, never hitSlop',
    (file) => {
      const xs = elements(
        file,
        (el, sf) =>
          TOUCHABLE_TAG.test(tagOf(el, sf)) && jsxChildren(el).some((ch) => tagOf(ch, sf) === 'X'),
      );
      expect(xs).toHaveLength(1);
      const x = xs[0]!;
      expect(attrText(x.el, 'accessibilityRole', x.sf)).toBe('button');
      expect(attrText(x.el, 'accessibilityLabel', x.sf)).toBe('Close');
      expect(attrText(x.el, 'hitSlop', x.sf)).toBeUndefined();
      expect(styleOf(x)).toContain('styles.close');
      const block = styleBlock(file, 'close');
      expect(block).toContain('minWidth: MIN_TAP');
      expect(block).toContain('minHeight: MIN_TAP');
    },
  );

  it('the photo viewer keeps its two names; Close is the named 44pt header chip', () => {
    const image = elements(VIEWER, (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)));
    expect(image).toHaveLength(1);
    expect(attrText(image[0]!.el, 'accessibilityLabel', image[0]!.sf)).toBe('Photo — tap to close');
    expect(attrText(image[0]!.el, 'accessibilityRole', image[0]!.sf)).toBe('button');
    const chip = elements(VIEWER, (el, sf) => tagOf(el, sf) === 'IconChip');
    expect(chip).toHaveLength(1);
    expect(attrText(chip[0]!.el, 'accessibilityLabel', chip[0]!.sf)).toBe('Close photo viewer');
    expect(attrText(chip[0]!.el, 'onPress', chip[0]!.sf)).toBe('onClose');
    expect(attrText(chip[0]!.el, 'minTap', chip[0]!.sf)).toBe('true');
    // A tap on the image still closes only while not zoomed, and the failed
    // image path is still wired.
    expect(codeOnly(sourceOf(VIEWER))).toContain('if (!zoomedRef.current) onClose();');
    expect(sourceOf(VIEWER)).toMatch(/<CachedImage\s+uri=\{uri\}[^>]*onError=\{onError\}/);
  });
});

// ── Gates ────────────────────────────────────────────────────────────────

describe('item screen: every control keeps its gate and its helper', () => {
  const code = flat(codeOnly(sourceOf(ITEM)));

  it('stock:adjust, stock:transfer and items:update through showWriteCtaForRole; Report a problem through showWriteCta', () => {
    expect(code).toContain(
      "const canTransfer = showWriteCtaForRole(role, permissions, 'stock:transfer');",
    );
    expect(code).toContain(
      "const canAdjustStock = showWriteCtaForRole(role, permissions, 'stock:adjust');",
    );
    expect(code).toContain(
      "const canMakeOwnItem = showWriteCtaForRole(role, permissions, 'items:update');",
    );
    expect(code).toContain(
      "const canReportProblem = enabledModules.has('maintenance_requests') && showWriteCta(permissions, 'maintenance_requests:submit');",
    );
    expect(code).toContain("const canQuickAdjust = canAdjustStock && item.status !== 'archived';");
    expect(code).toContain("const canWriteSerials = role !== null && role !== 'viewer';");
    expect(code).toContain(
      "const canRestore = isManager || (role !== null && can({ role: role as Role, permissions }, 'items:update'));",
    );
    expect(code).toContain(
      "const canEditNotes = isManager || (role !== null && can({ role: role as Role, permissions }, 'movements:edit_notes'));",
    );
    expect(code).toContain("cycleCountsEnabled: enabledModules.has('cycle_counts'),");
  });

  it('each control renders only behind its gate', () => {
    for (const gate of [
      '{canQuickAdjust ? ( <> <View style={styles.quickAdjust}>',
      '{canTransfer ? ( <Button',
      "{canAdjustStock && item.status !== 'archived' && item.quantity_on_hand > 0 ? ( <Button",
      '{canStartCounts && isCountableItem({ status: item.status, is_rental: item.is_rental, is_bundle: item.is_bundle }) ? ( <Button',
      '{canReportProblem ? ( <Button',
      "{item.status === 'archived' && canRestore ? ( <Button",
      '{canEditNotes && movement.note_editable ? (',
      'canWrite={canWriteSerials}',
      '{canWrite ? ( <Button',
    ]) {
      expect(code, gate).toContain(gate);
    }
    // Remove from group and Make this its own item: items:update, both.
    expect(code.match(/\{canMakeOwnItem \? \(/g)).toHaveLength(2);
  });
});

// ── Offline honesty ──────────────────────────────────────────────────────

describe('item screen: nothing implies saved stock before the server answers', () => {
  const code = flat(codeOnly(sourceOf(ITEM)));

  it("the unconfirmed and queued notes stay beside ON HAND, in the mode's warning ink", () => {
    expect(code).toContain(
      '{unconfirmed ? ( <Mono size={11.5} tracking={0.04} color={c.warnText} style={{ marginTop: 6 }}> {unconfirmedOnHandLabel(unconfirmed)} </Mono>',
    );
    expect(code).toContain(
      '{queuedAdjust.count > 0 ? ( <Mono size={11.5} tracking={0.04} color={c.warnText} style={{ marginTop: 6 }}> {queuedOnHandLabel(queuedAdjust)} </Mono>',
    );
  });

  it('the quick steps and the sheet still go through adjust(), which paints only the server total', () => {
    for (const [label, delta] of [
      ['−5', '-5'],
      ['−1', '-1'],
      ['+1', '1'],
      ['+5', '5'],
    ]) {
      expect(code).toContain(
        `<QuickBtn label="${label}" onPress={() => void adjust(${delta})} disabled={busy} />`,
      );
    }
    expect(code).toContain('const q = outcome.quantityOnHand;');
    expect(code).not.toMatch(/quantity_on_hand\s*\+\s*delta/);
    expect(code).toContain("if (kind !== 'refused') setAdjustOpen(false);");
  });
});

// ── The New item form: uncontrolled rack boxes and the measured footer ────

describe('New item form: the rack boxes stay uncontrolled', () => {
  // The 2026-09-24 "17-B became 1-B" incident: a controlled box's lagging
  // value round trip put stale text back into the native box.
  it('the rack boxes carry no value of any kind and write the refs as typed', () => {
    const rack = elements(
      NEW_ITEM,
      (el, sf) =>
        tagOf(el, sf) === 'BoxInput' &&
        /rack(Number|Row)Ref\.current = t;/.test(attrText(el, 'onChangeText', sf) ?? ''),
    );
    expect(rack).toHaveLength(2);
    for (const r of rack) {
      expect(attrText(r.el, 'value', r.sf), where(r)).toBeUndefined();
      expect(attrText(r.el, 'defaultValue', r.sf), where(r)).toBeUndefined();
    }
    const code = codeOnly(sourceOf(NEW_ITEM));
    expect(code).toContain('rackNumber: rackNumberRef.current,');
    expect(code).toContain('rackRow: rackRowRef.current,');
  });

  it('BoxInput passes no value of its own: it forwards its props and adds colours and focus only', () => {
    const inner = elements(
      NEW_ITEM,
      (el, sf) => tagOf(el, sf) === 'TextInput',
      (sf) => functionNamed(sf, 'BoxInput'),
    );
    expect(inner).toHaveLength(1);
    const el = inner[0]!;
    const attrs = (ts.isJsxElement(el.el) ? el.el.openingElement.attributes : el.el.attributes)
      .properties;
    const names = attrs.map((a) =>
      ts.isJsxSpreadAttribute(a) ? `...${a.expression.getText(el.sf)}` : a.name.getText(el.sf),
    );
    expect(names).toEqual(['...props', 'placeholderTextColor', 'onFocus', 'onBlur', 'style']);
  });

  it('the footer reservation is still measured, with 140 as its floor', () => {
    const code = flat(codeOnly(sourceOf(NEW_ITEM)));
    expect(code).toContain('paddingBottom: footerReservation(footerHeight, 140),');
    expect(code).toContain('onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}');
  });
});

// ── Each sheet keeps the sibling scrim ───────────────────────────────────

/**
 * Container -> [scrim, card] for a sheet: the container is the View with
 * accessibilityViewIsModal, the scrim a childless absolute-fill Pressable
 * painted first (a "Close" button a VoiceOver double tap and the escape scrub
 * close), the card a plain View or the component that draws it. Never a
 * touchable around the card (sheet-backdrop-guard.test.ts has the defect).
 */
describe.each([
  [MOVE, 'MoveStockModal', 'onClose'],
  [REMOVE, 'RemoveFromRackContent', 'onClose'],
  [RECOUNT, 'SheetContent', 'submitting ? undefined : dismiss'],
  [HISTORY, 'ItemHistorySheet', 'onClose'],
])('%s keeps the sibling scrim', (file, fn, close) => {
  const containers = () =>
    elements(
      file,
      (el, sf) => attrText(el, 'accessibilityViewIsModal', sf) === 'true',
      (sf) => functionNamed(sf, fn),
    );

  it('one modal container, closed by the escape scrub as by the scrim', () => {
    const c = containers();
    expect(c).toHaveLength(1);
    expect(tagOf(c[0]!.el, c[0]!.sf)).toBe('View');
    expect(attrText(c[0]!.el, 'onAccessibilityEscape', c[0]!.sf)).toBe(close);
    expect(flat(attrText(c[0]!.el, 'style', c[0]!.sf) ?? '')).toMatch(
      /justifyContent: 'flex-end'|styles\.scrim/,
    );
  });

  it('the scrim is a childless "Close" button behind the card, never its parent', () => {
    const c = containers()[0]!;
    const [scrim, card, ...rest] = jsxChildren(c.el);
    expect(rest).toHaveLength(0);
    expect(tagOf(scrim!, c.sf)).toBe('Pressable');
    expect(hasContent(scrim!)).toBe(false);
    expect(attrText(scrim!, 'onPress', c.sf)).toBe(close);
    expect(attrText(scrim!, 'onAccessibilityTap', c.sf)).toBe(close);
    expect(attrText(scrim!, 'accessibilityRole', c.sf)).toBe('button');
    expect(attrText(scrim!, 'accessibilityLabel', c.sf)).toBe('Close');
    expect(attrText(scrim!, 'style', c.sf)).toContain('StyleSheet.absoluteFill');
    expect(card && TOUCHABLE_TAG.test(tagOf(card, c.sf))).toBe(false);
  });

  it('the scrim keeps the per-mode scrim colours', () => {
    const c = containers()[0]!;
    const scrim = jsxChildren(c.el)[0]!;
    expect(flat(attrText(scrim, 'style', c.sf) ?? '')).toMatch(
      /ode === 'dark' \? 'rgba\(0,0,0,0\.(55|6)\)' : 'rgba\(14,15,13,0\.(35|4)\)'/,
    );
  });
});

// ── The recount sheet: once the result shows, every way out is Done ─────

describe('recount sheet: a started recount is never dismissed as if nothing happened', () => {
  // The defect: the scrim, the escape scrub and Android's back button called
  // onClose after the result showed (only the X called onDone), so a recount
  // started and then dismissed by a tap outside left the exceptions list with
  // its selection and no re-read, and the item card and the location as they
  // were. Every caller re-reads in onDone and only closes in onClose.
  const code = flat(codeOnly(sourceOf(RECOUNT)));

  it("the sheet's own ways out (scrim, escape scrub, X) take Done once the result shows", () => {
    expect(code).toContain('const dismiss = summary ? onDone : onClose;');
    const x = elements(
      RECOUNT,
      (el, sf) =>
        TOUCHABLE_TAG.test(tagOf(el, sf)) && jsxChildren(el).some((ch) => tagOf(ch, sf) === 'X'),
    );
    expect(x).toHaveLength(1);
    expect(attrText(x[0]!.el, 'onPress', x[0]!.sf)).toBe('dismiss');
    // Done itself, and Open the count, are unchanged.
    expect(code).toContain('<Button block onPress={onDone}> Done </Button>');
    expect(code).toContain('onPress={() => onOpenCount(summary.started!.cycleCountId)}');
  });

  it("the Modal's own way out (Android back) takes Done once the result shows, and each opening starts without one", () => {
    expect(code).toContain('onRequestClose={resultShown ? props.onDone : props.onClose}');
    expect(code).toContain(
      'if (props.visible !== wasVisible) { setWasVisible(props.visible); setResultShown(false); }',
    );
    expect(code).toContain(
      '<SheetContent key="open" {...props} onResultShown={() => setResultShown(true)} />',
    );
    // Reported only when the result is set, never before the answer.
    expect(code).toMatch(
      /setSummary\(recountResultSummary\(result, \{ timeZone, assigneeLabel \}\)\); onResultShown\(\); \} catch/,
    );
  });

  // The item screen's two handlers show why the difference matters: only
  // Done re-reads the last physical count card. (The exceptions list, the
  // exception detail and the location screen, the sheet's other callers, do
  // the same in their onDone; they belong to another package, so this test
  // reads only this one.)
  it('the item screen re-reads its card in onDone and only closes in onClose', () => {
    const sheet = elements(ITEM, (el, sf) => tagOf(el, sf) === 'ExceptionRecountSheet');
    expect(sheet).toHaveLength(1);
    const done = flat(attrText(sheet[0]!.el, 'onDone', sheet[0]!.sf) ?? '');
    const close = flat(attrText(sheet[0]!.el, 'onClose', sheet[0]!.sf) ?? '');
    expect(done).toContain('setCountOpen(false);');
    expect(done).toContain('refreshVerification();');
    expect(close).toBe('() => setCountOpen(false)');
  });
});

// ── The serial status pills (integrator decision, 2026-10-18) ────────────

/** The SERIAL_PILL_STATUS map, read from the item screen's source. */
function serialPillMap(): Record<string, string> {
  const src = codeOnly(sourceOf(ITEM));
  const block = /const SERIAL_PILL_STATUS: Record<SerialStatus, PillStatus> = \{([\s\S]*?)\};/.exec(
    src,
  )?.[1];
  expect(block, 'SERIAL_PILL_STATUS not found').toBeDefined();
  const out: Record<string, string> = {};
  for (const m of block!.matchAll(/(\w+): '(\w+)'/g)) out[m[1]!] = m[2]!;
  return out;
}

describe('serial status pills take the shared pill tones', () => {
  it('the map is the integrator decision, for every status the registry knows', () => {
    expect(serialPillMap()).toEqual({
      available: 'ok',
      reserved: 'default',
      damaged: 'warn',
      rejected: 'crit',
      sold: 'default',
      rma: 'warn',
    });
    expect(Object.keys(serialPillMap()).sort()).toEqual([...SERIAL_STATUSES].sort());
  });

  it.each(MODES)(
    'every chip reads at AA in %s mode, and every picker dot at 3:1 on the card',
    (_mode, c) => {
      for (const [status, pill] of Object.entries(serialPillMap())) {
        const tone = pillTone(pill as PillStatus, c);
        expect(contrast(tone.fg, tone.bg), `${status} words`).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrast(tone.fg, c.card), `${status} dot`).toBeGreaterThanOrEqual(AA_UI);
      }
    },
  );

  it('the pill and the picker read the map; the old fixed tints have no caller here', () => {
    const code = codeOnly(sourceOf(ITEM));
    expect(code).toContain('<Pill status={SERIAL_PILL_STATUS[status]}>');
    expect(code).toContain('const tone = pillTone(SERIAL_PILL_STATUS[s], c);');
    expect(code).not.toContain('serialStatusColor');
    // The words on each chip are unchanged: the label, uppercased.
    expect(code).toContain('{SERIAL_STATUS_LABELS[status].toUpperCase()}');
  });
});

// ── Colours: the per-mode palette only ───────────────────────────────────

describe('colours come from the per-mode palette', () => {
  // Mutation caught: a screen back on the light-only legacy alias, or a word
  // in a single-mode ACCENT value (ACCENT.warn is 3.4:1 on light paper,
  // ACCENT.crit 3.1:1 on the dark card, ACCENT.mintInk 2.7:1 on it).
  it.each(OWNED)('%s imports neither the legacy theme alias nor ACCENT', (file) => {
    const src = codeOnly(sourceOf(file));
    expect(src).not.toMatch(/import \{[^}]*\b(theme|ACCENT)\b[^}]*\} from '@\/lib\/theme'/);
    expect(src).not.toMatch(/\bACCENT\./);
  });

  // paper2 is the card colour in dark: a well or a box on a card showed
  // nothing there. The recessed fill is sunk.
  it.each(OWNED)('%s fills no well with paper2', (file) => {
    expect(codeOnly(sourceOf(file))).not.toMatch(/\bc\.paper2\b/);
  });

  /**
   * Where the faint inks (ink4 / ink5, 1.8-3.7:1) may still appear: as a
   * decorative glyph or mark, never as words. Each use is listed with the
   * element and the property it colours.
   */
  function faintInkUses(file: string): string[] {
    const sf = treeOf(file);
    const out: string[] = [];
    const visit = (n: ts.Node, jsx: JsxNode[]) => {
      let stack = jsx;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) stack = [...jsx, n];
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'c' &&
        /^ink[45]$/.test(n.name.text)
      ) {
        let prop = '?';
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (ts.isJsxAttribute(p)) {
            prop = p.name.getText(sf);
            break;
          }
          if (ts.isPropertyAssignment(p)) {
            prop = p.name.getText(sf);
            break;
          }
        }
        const el = stack[stack.length - 1];
        out.push(`${el ? tagOf(el, sf) : '-'}.${prop}=${n.name.text}`);
      }
      ts.forEachChild(n, (ch) => visit(ch, stack));
    };
    visit(sf, []);
    return out;
  }

  it.each([
    [
      ITEM,
      [
        'ArrowLeftRight.color=ink4',
        'History.color=ink4',
        'View.backgroundColor=ink5',
        'View.backgroundColor=ink5',
        'View.backgroundColor=ink5',
        'View.backgroundColor=ink5',
      ],
    ],
    [NEW_ITEM, []],
    [MOVE, ['View.backgroundColor=ink5']],
    [REMOVE, ['View.backgroundColor=ink5']],
    [RECOUNT, []],
    [HISTORY, ['View.backgroundColor=ink5']],
    [CARD, []],
    [VIEWER, []],
  ])('%s: the faint inks colour only the empty-state glyphs and the grabbers', (file, expected) => {
    expect(faintInkUses(file)).toEqual(expected);
  });

  it('every ink5 fill is a sheet grabber (36 x 5)', () => {
    for (const file of [ITEM, MOVE, REMOVE, HISTORY]) {
      const grabbers = elements(file, (el, sf) =>
        /\bc\.ink5\b/.test(attrText(el, 'style', sf) ?? ''),
      );
      expect(grabbers.length).toBeGreaterThan(0);
      for (const g of grabbers) {
        const style = styleOf(g);
        const ok =
          style.includes('styles.grabber') ||
          style.includes('width: 36, height: 5, borderRadius: 100');
        expect(ok, where(g)).toBe(true);
      }
    }
    expect(styleBlock(ITEM, 'grabber')).toContain('width: 36, height: 5, borderRadius: 100');
    expect(styleBlock(HISTORY, 'grabber')).toContain('width: 36, height: 5, borderRadius: 100');
  });

  /** Colour literals in code (hex, rgb, hsl), wherever they are written. */
  function colourLiterals(file: string): { text: string; context: string }[] {
    const sf = treeOf(file);
    const out: { text: string; context: string }[] = [];
    const visit = (n: ts.Node) => {
      if (
        (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        /^#[0-9a-f]{3,8}$|^(rgb|hsl)a?\(/i.test(n.text)
      ) {
        out.push({ text: n.text, context: flat(n.parent.getText(sf)) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  // The scrims are the only colours written by hand: a dimming layer over
  // the page, per mode, as every phone sheet's (sheet-a11y-structure.test.ts).
  it.each(OWNED)('%s writes no colour by hand but the per-mode scrim', (file) => {
    for (const lit of colourLiterals(file)) {
      expect(
        ['rgba(0,0,0,0.55)', 'rgba(14,15,13,0.35)', 'rgba(0,0,0,0.6)', 'rgba(14,15,13,0.4)'],
        `${file}: ${lit.text}`,
      ).toContain(lit.text);
      expect(lit.context, `${file}: ${lit.text}`).toMatch(/ode === 'dark' \?/);
    }
  });

  it('a photo sits on the photo ground (white in both modes), the empty tile on the recessed fill', () => {
    expect(flat(codeOnly(sourceOf(ITEM)))).toContain(
      'backgroundColor: item.imageUrl ? PHOTO_BACKGROUND : c.sunk,',
    );
    expect(styleBlock(NEW_ITEM, 'photoThumb')).toContain('backgroundColor: PHOTO_BACKGROUND');
  });
});

describe('the pairs this package draws, measured in both modes', () => {
  /** [what, words or mark, ground, the minimum]. */
  const PAIRS: [string, keyof Palette, keyof Palette, number][] = [
    ['muted words on the card (meta, labels, hints, placeholders)', 'ink3', 'card', AA_TEXT],
    ['muted words on the page (form helpers, notes)', 'ink3', 'paper', AA_TEXT],
    ['muted words and placeholders in a recessed box', 'ink3', 'sunk', AA_TEXT],
    ['an idle tab label on the track', 'ink3', 'sunk', AA_TEXT],
    ['the open tab label on its card segment', 'ink', 'card', AA_TEXT],
    ['secondary words on the card (the viewer label, chip values)', 'ink2', 'card', AA_TEXT],
    ['an idle choice chip on the page', 'ink2', 'paper', AA_TEXT],
    ['history values and the put-away source on the recessed fill', 'ink2', 'sunk', AA_TEXT],
    ['typed text in a recessed box', 'ink', 'sunk', AA_TEXT],
    ['an idle sheet chip (SheetChip) on its recessed fill', 'ink', 'sunk', AA_TEXT],
    ['a chosen sheet chip (SheetChip): card on ink', 'card', 'ink', AA_TEXT],
    ['a chosen chip, Create and a chosen warehouse: paper on ink', 'paper', 'ink', AA_TEXT],
    ['an open exception chip', 'ink', 'warnWash', AA_TEXT],
    ['the unconfirmed and queued notes, the as-of banner', 'warnText', 'card', AA_TEXT],
    ['the rack hint on the page', 'warnText', 'paper', AA_TEXT],
    ['a warning amount on a history row', 'warnText', 'sunk', AA_TEXT],
    ['the reversal note on its wash', 'warnText', 'warnWash', AA_TEXT],
    ['refusals and NEW TOTAL below zero on the card', 'critText', 'card', AA_TEXT],
    ['a read failure on the page', 'critText', 'paper', AA_TEXT],
    ['a removal amount on a history row', 'critText', 'sunk', AA_TEXT],
    ['an added amount on a movement card', 'accent', 'card', AA_TEXT],
    ['an added amount on a history row', 'accent', 'sunk', AA_TEXT],
    ['the open tab ring against the track', 'ink3', 'sunk', AA_UI],
    ['an idle radio mark on the card', 'ink3', 'card', AA_UI],
    ['the chosen radio mark in its recessed fill', 'ink', 'sunk', AA_UI],
    ['the crate dot ring on the card', 'ink3', 'card', AA_UI],
    ['a movement pip (add) in its recessed well', 'accent', 'sunk', AA_UI],
    ['a movement pip (removal) in its recessed well', 'critText', 'sunk', AA_UI],
    ['a movement pip (other) in its recessed well', 'warnText', 'sunk', AA_UI],
    ['the empty-state glyph on the page', 'ink4', 'paper', AA_UI],
    ['a spinner on the card', 'ink3', 'card', AA_UI],
  ];

  it.each(MODES)('%s mode', (_mode, c) => {
    for (const [what, fg, bg, min] of PAIRS) {
      expect(contrast(c[fg], c[bg]), what).toBeGreaterThanOrEqual(min);
    }
  });
});

// ── 44pt targets ─────────────────────────────────────────────────────────

describe('every control is a 44pt target', () => {
  // The shared small Button is 36pt: every one on these screens takes 44.
  it.each(OWNED)('%s: every small Button has a 44pt minHeight', (file) => {
    for (const b of elements(file, (el, sf) => tagOf(el, sf) === 'Button')) {
      if (attrText(b.el, 'size', b.sf) !== 'sm') continue;
      expect(styleOf(b), where(b)).toContain('minHeight: MIN_TAP');
    }
  });

  it('the item screen frames: the tabs, the steps, Replace, the note link, Load more, Edit on web', () => {
    expect(styleBlock(ITEM, 'tab')).toContain('minHeight: MIN_TAP');
    expect(styleBlock(ITEM, 'quickBtn')).toContain('minHeight: 52');
    const code = flat(codeOnly(sourceOf(ITEM)));
    // Replace photo, the note link, Load more (both) and Edit on web.
    expect(code.match(/minHeight: MIN_TAP,/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(code).not.toMatch(/hitSlop=/);
  });

  it('the form frames: every chip, Scan instead, Auto and the remove X', () => {
    expect(styleBlock(NEW_ITEM, 'chipTall')).toBe(' minHeight: 44, ');
    expect(codeOnly(sourceOf(NEW_ITEM))).toMatch(/styles\.chip,\s*styles\.chipTall,/);
    expect(styleBlock(NEW_ITEM, 'scanShortcut')).toContain('minHeight: MIN_TAP');
    expect(styleBlock(NEW_ITEM, 'autoSku')).toContain('minHeight: MIN_TAP');
    expect(styleBlock(NEW_ITEM, 'autoSku')).toContain('minWidth: MIN_TAP');
    expect(sourceOf(NEW_ITEM)).toContain('const MIN_TAP = 44;');
  });

  // The shared chip is about 36.5pt (9pt padding twice, a 16.5pt mono line,
  // the border): every choice in the two sheets is the 44pt SheetChip.
  it.each([MOVE, REMOVE])('%s: every choice chip is the 44pt SheetChip', (file) => {
    expect(elements(file, (el, s) => tagOf(el, s) === 'Chip')).toHaveLength(0);
    expect(sourceOf(file)).not.toContain("from '@/components/ui/chip'");
    expect(elements(file, (el, s) => tagOf(el, s) === 'SheetChip')).toHaveLength(
      file === MOVE ? 4 : 1,
    );
  });

  it('SheetChip is the shared chip recipe with a 44pt minimum height', () => {
    const sf = treeOf(MOVE);
    const fn = flat(codeOnly(functionNamed(sf, 'SheetChip').getText(sf)));
    expect(codeOnly(sourceOf(MOVE))).toContain('const MIN_TAP = 44;');
    expect(fn).toContain('minHeight: MIN_TAP,');
    expect(fn).toContain("justifyContent: 'center',");
    expect(fn).toContain('accessibilityRole="button"');
    expect(fn).toContain('accessibilityState={{ selected: active }}');
    expect(fn).toContain('borderColor: active ? c.ink : c.hair2,');
    expect(fn).toContain('backgroundColor: active ? c.ink : c.sunk,');
    expect(fn).toContain('<Mono size={12.5} color={active ? c.card : c.ink}>');
    expect(fn).toContain('borderColor: active ? c.card : c.hair2,');
    expect(fn).not.toMatch(/(^|[^a-zA-Z])height: (?!10)/);
    expect(sourceOf(MOVE)).toMatch(/\nexport function SheetChip\(/);
  });

  // A frame is only a 44pt target where no later sibling covers it (a later
  // sibling wins the tap): each frame's margins give back exactly what it
  // borrows, and its padding keeps the mark where it was.
  it('SKU Auto runs from the NAME box to the SKU box, covering neither', () => {
    const block = styleBlock(NEW_ITEM, 'autoSku');
    expect(block).toContain('marginTop: -22, marginBottom: -6, paddingTop: 22, paddingBottom: 6,');
    expect(block).not.toContain('marginVertical');
    const code = flat(codeOnly(sourceOf(NEW_ITEM)));
    expect(code).toContain('const SKU_ROW_GAP = 8;');
    expect(code).toContain('<Row marginTop={SKU_ROW_GAP}> <Field flex label="SKU"');
    // Above: the SKU field's 14pt top margin and the row's gap reach the
    // NAME box; below: the 16pt label row and Field's 6pt gap reach the SKU box.
    expect(code).toContain(
      '<View style={{ marginTop: 14, flex: flex && !stacked ? 1 : undefined }}>',
    );
    expect(code).toContain('<View style={{ marginTop: 6 }}>{children}</View>');
    // What the frame keeps in the layout is the label row's 16pt.
    expect(MIN_TAP_PT - 22 - 6).toBe(16);
  });

  it('the history X ends where the item name starts', () => {
    const block = styleBlock(HISTORY, 'close');
    expect(block).toContain('marginTop: -18, marginBottom: -8, paddingTop: 18, paddingBottom: 8,');
    expect(block).not.toContain('marginVertical');
    // The 8pt below is the header's bottom padding, above the item name.
    expect(styleBlock(HISTORY, 'header')).toContain('paddingBottom: 8,');
    expect(MIN_TAP_PT - 18 - 8).toBe(18); // the X's own 18pt in the layout
    expect(codeOnly(sourceOf(HISTORY))).toContain('<X size={18}');
  });

  it('the card keeps its 44pt rule (the location screen imports it)', () => {
    expect(sourceOf(CARD)).toMatch(/export const MIN_TAP = 44;/);
  });
});

// ── Dynamic Type ─────────────────────────────────────────────────────────

describe('Dynamic Type policy unchanged', () => {
  it('the tab labels and the quick steps are capped at the control ceiling, one line each', () => {
    const code = flat(codeOnly(sourceOf(ITEM)));
    expect(code).toContain('const TAB_CAP = capTo(13, TYPE_CEILING.control);');
    expect(code).toContain('maxFontSizeMultiplier={TAB_CAP}');
    // Re-pinned by docket B10 (was `numberOfLines={1} maxFontSizeMultiplier=
    // {TAB_CAP} adjustsFontSizeToFit minimumFontScale={TAB_MIN_FONT_SCALE}`):
    // a label is never shrunk below the size the user chose (the Dynamic Type
    // policy forbids adjustsFontSizeToFit). A label wider than its segment
    // stacks the tabs instead (the next two tests).
    expect(code).toContain(
      'numberOfLines={1} maxFontSizeMultiplier={TAB_CAP} color={active ? c.ink : c.ink3}',
    );
    expect(code).not.toContain('adjustsFontSizeToFit');
    expect(code).not.toContain('minimumFontScale');
    expect(code).not.toContain('TAB_MIN_FONT_SCALE');
    expect(code).toContain('maxFontSizeMultiplier={capTo(17, TYPE_CEILING.control)}');
    expect(code).toContain('maxFontSizeMultiplier={capTo(56, TYPE_CEILING.display)}');
  });

  // The segmented track takes about 23pt from each column. Re-pinned by
  // docket B10 (was: Movements fits the narrowest segment at the shrink floor
  // TAB_MIN_FONT_SCALE): the stacking rule (shouldStackItemTabs,
  // dynamic-type-layout.test.ts) measures the segment these styles draw, at
  // the label's cap. Measured with fontkit on the bundled
  // InterTight_600SemiBold.ttf: Movements advances 117.3pt at 22pt (the cap),
  // without the negative tracking that narrows it.
  it('the stacking rule measures the segments these styles draw, at the label cap', () => {
    const num = (block: string, key: string) => {
      const m = new RegExp(`(?:^|[ ,])${key}: (\\d+(?:\\.\\d+)?),`).exec(block);
      expect(m, `${key} in ${block}`).not.toBeNull();
      return Number(m![1]);
    };
    const row = styleBlock(ITEM, 'tabsRow');
    const tab = styleBlock(ITEM, 'tab');
    const trackSide = num(row, 'marginHorizontal') + num(row, 'borderWidth') + num(row, 'padding');
    const tabSide = num(tab, 'borderWidth') + num(tab, 'paddingHorizontal');
    const segment = (screen: number) =>
      (screen - 2 * trackSide - 2 * num(row, 'gap')) / 3 - 2 * tabSide;
    const stackedLine = (screen: number) => screen - 2 * trackSide - 2 * tabSide;
    for (const screen of [320, 375, 390, 393, 402, 430, 440, 744, 1024]) {
      expect(itemTabLabelRoom(screen), `${screen}pt`).toBeCloseTo(segment(screen), 10);
      expect(itemTabStackedLabelRoom(screen), `${screen}pt`).toBeCloseTo(stackedLine(screen), 10);
    }
    expect(segment(320)).toBeCloseTo(70, 5);
    // The rule's label cap is the screen's TAB_CAP.
    expect(capTo(13, TYPE_CEILING.control) * 13).toBe(22);
    expect(itemTabLabelSize(capTo(13, TYPE_CEILING.control))).toBeCloseTo(22, 10);
    expect(itemTabLabelSize(10)).toBeCloseTo(22, 10);
    expect(ITEM_TAB_WIDEST_LABEL_EM * 22).toBeCloseTo(117.3, 1);
    // The default 13pt fits a 320pt zoomed screen side by side; stacked, the
    // ceiling fits it with room.
    expect(ITEM_TAB_WIDEST_LABEL_EM * 13).toBeLessThanOrEqual(segment(320));
    expect(ITEM_TAB_WIDEST_LABEL_EM * 22).toBeLessThanOrEqual(stackedLine(320));
  });

  // Mutations caught: the stacking rule left unread (the tabs cut or shrunk
  // again), read with a stale scale, or a stacked tab still flex: 1 in a
  // column (each tab would share a height the track does not have).
  it('the tabs stack, one per line, when the widest label is wider than its segment', () => {
    const screen = flat(codeOnly(functionNamed(treeOf(ITEM), 'ItemDetail').getText(treeOf(ITEM))));
    expect(screen).toContain('const { width: windowWidth, fontScale } = useWindowDimensions();');
    expect(screen).toContain('const stackTabs = shouldStackItemTabs(windowWidth, fontScale);');
    expect(screen).toContain(
      'style={[ styles.tabsRow, stackTabs ? styles.tabsStacked : null, { backgroundColor: c.sunk, borderColor: c.hair }, ]}',
    );
    expect(screen.split('stacked={stackTabs}').length - 1).toBe(3);
    const button = flat(codeOnly(functionNamed(treeOf(ITEM), 'TabButton').getText(treeOf(ITEM))));
    expect(button).toContain('stacked: boolean;');
    expect(button).toContain('styles.tab, stacked ? styles.tabStacked : null,');
    expect(styleBlock(ITEM, 'tabsStacked')).toBe(" flexDirection: 'column', ");
    expect(styleBlock(ITEM, 'tabStacked')).toBe(' flex: 0, ');
    // A stacked tab keeps its 44pt and its centred label.
    expect(styleBlock(ITEM, 'tab')).toContain('minHeight: MIN_TAP');
    expect(styleBlock(ITEM, 'tab')).toContain("alignItems: 'center',");
  });

  // A fixed height clipped the typed text: every typed box grows with it.
  it.each(OWNED)('%s: no typed box has a fixed height, and none caps the typed text', (file) => {
    for (const box of elements(file, (el, sf) => tagOf(el, sf) === 'TextInput')) {
      expect(styleOf(box), where(box)).not.toMatch(/(^|[^a-zA-Z])height:/);
      expect(attrText(box.el, 'maxFontSizeMultiplier', box.sf), where(box)).toBeUndefined();
    }
  });

  it('the meta rows still reflow past the stacking scale instead of capping', () => {
    const fn = flat(functionNamed(treeOf(ITEM), 'MetaRow').getText(treeOf(ITEM)));
    expect(fn).toContain('const stacked = shouldStackRow(fontScale);');
  });

  it('the form rows still stack past the stacking scale', () => {
    expect(flat(codeOnly(sourceOf(NEW_ITEM)))).toContain(
      "flexDirection: stacked ? 'column' : 'row'",
    );
  });
});

/**
 * A live text-size change remounts the item screen's hero, the words of its
 * photo tile (Replace, or Tap to add photo on an item with no photo) and its
 * tab track (docket B60). With an item open, the simulator walk of 2026-10-31
 * saw the tab labels cut ('Over…', 'Movem…', 'Acti…'), the name's descender,
 * 'REPLAC' and, at the accessibility sizes, the SKU and category lines
 * clipped, until a tab changed state or the item was opened again. It is the
 * stale measurement B10 fixed in the shared list chrome (fontScaleKey,
 * primitives-structure.test.ts); since B10 no tab label shrinks to fit, so a
 * stale segment cuts it. Tap to add photo is the same Mono as Replace (11pt,
 * the same tracking, upper case, uncapped), in the same tile.
 */
describe("the item screen measures its header, its photo tile's words and its tabs again at a new text size", () => {
  const inScreen = (sf: ts.SourceFile) => functionNamed(sf, 'ItemDetail');

  it('turns the text size the tabs already read into a key', () => {
    expect(flat(codeOnly(sourceOf(ITEM)))).toMatch(
      /import \{[^}]*\bfontScaleKey\b[^}]*\} from '@\/lib\/dynamic-type-layout';/,
    );
    const screen = flat(codeOnly(inScreen(treeOf(ITEM)).getText(treeOf(ITEM))));
    expect(screen).toContain('const { width: windowWidth, fontScale } = useWindowDimensions();');
    expect(screen).toContain('const scaleKey = fontScaleKey(fontScale);');
  });

  // Mutations caught: any of the three keys dropped, or the chip's key moved
  // to the photo above it.
  it('the hero, Replace and the tab track are keyed on it', () => {
    const one = (match: (el: JsxNode, sf: ts.SourceFile) => boolean) => {
      const found = elements(ITEM, match, inScreen);
      expect(found).toHaveLength(1);
      return attrText(found[0]!.el, 'key', found[0]!.sf);
    };
    expect(one((el, sf) => attrText(el, 'style', sf) === 'styles.hero')).toBe('`hero-${scaleKey}`');
    expect(one((el, sf) => attrText(el, 'accessibilityLabel', sf) === 'Replace photo')).toBe(
      '`replace-${scaleKey}`',
    );
    expect(one((el, sf) => attrText(el, 'accessibilityRole', sf) === 'tablist')).toBe(
      '`tabs-${scaleKey}`',
    );
  });

  // Review of B60 (2026-10-31): on an item with no photo the tile shows Tap to
  // add photo, the same Mono as Replace, which the walk saw cut ('REPLAC').
  // Its View holds only the camera icon and those words: no image to load
  // again. Mutations caught: the key dropped, or moved up to the tile (the
  // photo would load again on every text-size change).
  it("with no photo, the tile's Tap to add photo is keyed on it too", () => {
    const words = elements(
      ITEM,
      (el, sf) =>
        tagOf(el, sf) === 'View' &&
        jsxChildren(el).some(
          (ch) => tagOf(ch, sf) === 'Mono' && textOf(ch, sf) === 'Tap to add photo',
        ),
      inScreen,
    );
    expect(words).toHaveLength(1);
    expect(attrText(words[0]!.el, 'key', words[0]!.sf), where(words[0]!)).toBe(
      '`add-photo-${scaleKey}`',
    );
    expect(jsxChildren(words[0]!.el).map((ch) => tagOf(ch, words[0]!.sf))).toEqual([
      'Camera',
      'Mono',
    ]);
  });

  // A remount resets whatever a subtree holds. These four hold words, badges
  // and buttons whose state lives in ItemDetail; the scroll view (its place,
  // pull to refresh), the photo (it would load again), the tab contents (the
  // serials, a movement's note sheet, the count card's retry) and the sheets
  // keep theirs. Mutations caught: the key moved to the ScrollView, the photo
  // or a tab's contents, or a stateful element moved into a keyed subtree.
  it('nothing keyed on it holds state a remount would lose', () => {
    const keyed = elements(
      ITEM,
      (el, sf) => (attrText(el, 'key', sf) ?? '').includes('scaleKey'),
      inScreen,
    );
    expect(keyed.map((k) => attrText(k.el, 'key', k.sf))).toEqual([
      '`hero-${scaleKey}`',
      '`add-photo-${scaleKey}`',
      '`replace-${scaleKey}`',
      '`tabs-${scaleKey}`',
    ]);
    const stateless = new Set([
      'View',
      'Mono',
      'Display',
      'Body',
      'Pill',
      'Button',
      'ActivityIndicator',
      'RotateCcw',
      'Pressable',
      'Camera',
      'TabButton',
    ]);
    for (const k of keyed) {
      walkJsx(k.el, (el) => {
        expect(stateless.has(tagOf(el, k.sf)), `${where(k)} holds <${tagOf(el, k.sf)}>`).toBe(true);
      });
    }
    // TabButton and the shared parts it and the hero draw keep no state.
    const hooks = /\b(useState|useReducer|useRef|useEffect|useLayoutEffect)\b/;
    expect(functionNamed(treeOf(ITEM), 'TabButton').getText(treeOf(ITEM))).not.toMatch(hooks);
    for (const part of ['button', 'pill', 'text']) {
      expect(sourceOf(`src/components/ui/${part}.tsx`), part).not.toMatch(hooks);
    }
    for (const tag of ['ScrollView', 'CachedImage']) {
      const found = elements(ITEM, (el, sf) => tagOf(el, sf) === tag, inScreen);
      expect(found.length, tag).toBeGreaterThan(0);
      for (const f of found) expect(attrText(f.el, 'key', f.sf), where(f)).toBeUndefined();
    }
    const roots = elements(
      ITEM,
      (el, sf) => /^\[\s*styles\.root,/.test(attrText(el, 'style', sf) ?? ''),
      inScreen,
    );
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(attrText(r.el, 'key', r.sf), where(r)).toBeUndefined();
  });
});

// ── The web path still lands on the item screen ──────────────────────────

describe('the inventory deep-link shim lands on this screen', () => {
  it('app/dashboard/inventory/[id] redirects to /item/[id] with the id', () => {
    expect(flat(sourceOf(SHIM))).toContain(
      "<Redirect href={{ pathname: '/item/[id]', params: { id } }} />",
    );
  });

  it('the screen is a registered card and reads the id and the tab', () => {
    // The root stack (P5.4's file), read flat and without comments, so a
    // reformat there cannot fail this pin.
    expect(flat(codeOnly(sourceOf('app/_layout.tsx')))).toContain(
      '<Stack.Screen name="item/[id]" options={{ presentation: \'card\' }} />',
    );
    const code = flat(codeOnly(sourceOf(ITEM)));
    expect(code).toContain(
      'const { id, tab: tabParam } = useLocalSearchParams<{ id: string; tab?: string }>();',
    );
    expect(code).toContain(
      "tabParam === 'movements' || tabParam === 'activity' ? tabParam : 'overview'",
    );
  });
});
