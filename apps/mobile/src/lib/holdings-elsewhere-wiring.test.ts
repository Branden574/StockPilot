import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for 0371 on the phone: the four surfaces that show where an
 * item's stock is (item screen, scan sheet, Move stock, Remove from rack).
 *
 * The behaviour is tested on the pure modules (holdings-elsewhere.test.ts,
 * placement-rows.test.ts, move-stock-form.test.ts). The screens themselves
 * cannot be loaded under vitest (they import native modules at load), so what
 * is left to pin is that each one ASKS those modules, and asks in parallel:
 *
 *   • the stock-in-other-warehouses read starts alongside the screen's own
 *     reads, never chained after the holdings read (a serial chain is what
 *     stalls screens on a slow gateway);
 *   • a failed read reaches the screen as a stated condition (the unavailable
 *     note, the sheet's empty text), never as a silent empty answer;
 *   • nothing but src/lib/holdings-elsewhere.ts calls the RPC, so the manager
 *     skip and the failure rules cannot be bypassed by a second caller.
 */

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8');
/** Source with comments stripped: the pins are about what the code DOES. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const moveModal = codeOnly(read('../components/move-stock-modal.tsx'));
const removeModal = codeOnly(read('../components/remove-from-rack-modal.tsx'));
const itemScreen = codeOnly(read('../../app/item/[id].tsx'));
const scanScreen = codeOnly(read('../../app/(drawer)/(tabs)/scan.tsx'));

/** The source between `start` and the first `end` after it. */
function between(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  expect(at, `${start} not found`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, at + start.length);
  expect(stop, `${end} not found after ${start}`).toBeGreaterThan(-1);
  return src.slice(at, stop);
}

describe('Move stock (move-stock-modal.tsx)', () => {
  const openReads = between(moveModal, 'await Promise.all([', 'if (cancelled) return;');

  it('reads the elsewhere totals and the writable warehouses IN THE SAME Promise.all as the holdings', () => {
    expect(openReads).toContain(".from('item_stock_levels')");
    expect(openReads).toContain('readItemElsewhere(supabase, itemId, role)');
    expect(openReads).toContain('readDestinationWarehouseScope(supabase, {');
  });

  it('reads neither in put-away (a fixed, visible source already scopes it)', () => {
    expect(openReads).toContain('freeForm ? readItemElsewhere(');
    expect(openReads).toContain('Promise.resolve(NO_ELSEWHERE)');
    expect(openReads).toContain('Promise.resolve(UNRESTRICTED)');
    expect(moveModal).toContain('const freeForm = !putAwaySourceLocationId;');
  });

  it('narrows the RENDERED destinations to writable warehouses (Q4)', () => {
    const decl = between(moveModal, 'const destChoices', ';\n');
    expect(decl).toContain('writableWarehouseIds: destScope.writableIds');
  });

  it('the empty state and the FROM note come from the shared decision', () => {
    expect(between(moveModal, ') : holdings.length === 0 ? (', ') : destChoices')).toContain(
      '{elsewhereCopy.empty}',
    );
    expect(moveModal).toContain('!fixedSource && elsewhereCopy.note ? (');
    expect(moveModal).toContain('elsewhereSourcesCopy({');
  });

  it('a failed access read is SAID, in both places a narrowed list shows', () => {
    expect(
      moveModal.match(/DESTINATION_ACCESS_UNREADABLE_NOTE/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(moveModal).toContain('destScope.unreadable ? (');
  });

  it('a failed HOLDINGS read is said, before any empty state can describe stock', () => {
    const afterReads = between(
      moveModal,
      'if (cancelled) return;\n      if (holdingsRes.error) {',
      'return;',
    );
    expect(afterReads).toContain('setHoldingsUnreadable(true);');
    expect(between(moveModal, ') : holdingsUnreadable ? (', ') : sourceMissing ? (')).toContain(
      '{SHEET_HOLDINGS_UNREADABLE_NOTE}',
    );
    // Checked before the empty state, not after it.
    expect(moveModal.indexOf(') : holdingsUnreadable ? (')).toBeLessThan(
      moveModal.indexOf(') : holdings.length === 0 ? ('),
    );
  });

  it('resets both on every open, so one item never shows another item’s answer', () => {
    const reset = between(
      moveModal,
      "setChosenFromId('');\n    setWarehouseName(null);",
      'void (async',
    );
    expect(reset).toContain('setElsewhere(NO_ELSEWHERE);');
    expect(reset).toContain('setDestScope(UNRESTRICTED);');
  });
});

describe('Remove from rack (remove-from-rack-modal.tsx)', () => {
  it('reads the elsewhere totals in the same Promise.all as the holdings', () => {
    const openReads = between(removeModal, 'await Promise.all([', 'if (cancelled) return;');
    expect(openReads).toContain(".from('item_stock_levels')");
    expect(openReads).toContain('readItemElsewhere(supabase, itemId, role)');
  });

  it('the empty state and the note come from the shared decision', () => {
    expect(between(removeModal, ') : holdings.length === 0 ? (', ') : (')).toContain(
      '{elsewhereCopy.empty}',
    );
    expect(removeModal).toContain('{elsewhereCopy.note ? (');
    expect(removeModal).toContain('holdsSomeHere,');
  });

  it('a failed HOLDINGS read is said, before any empty state can describe stock', () => {
    expect(
      between(removeModal, 'if (cancelled) return;\n      if (res.error) {', 'return;'),
    ).toContain('setHoldingsUnreadable(true);');
    expect(removeModal.indexOf(') : holdingsUnreadable ? (')).toBeGreaterThan(-1);
    expect(removeModal.indexOf(') : holdingsUnreadable ? (')).toBeLessThan(
      removeModal.indexOf(') : holdings.length === 0 ? ('),
    );
    expect(removeModal).toContain('{SHEET_HOLDINGS_UNREADABLE_NOTE}');
  });

  it('knows whether the member holds ANY stock here, not only placed stock', () => {
    expect(removeModal).toContain('setHoldsSomeHere(all.length > 0);');
    expect(removeModal).toContain(
      "const hs = all.filter((h) => h.kind !== 'staging' && h.kind !== 'unplaced');",
    );
  });
});

describe('item screen (app/item/[id].tsx)', () => {
  const load = between(
    itemScreen,
    'const load = React.useCallback(async () => {',
    '}, [id, router, role]);',
  );

  it('starts the read BEFORE the item read, and awaits it with the holdings', () => {
    const start = load.indexOf('readItemElsewhere(supabase, id, role)');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(load.indexOf(".from('inventory_items')"));
    const all = between(load, 'await Promise.all([', ']);');
    expect(all).toContain(".from('item_stock_levels')");
    expect(all).toContain('elsewhereRead,');
  });

  it('hands the answer to the shared row builder and says a failure', () => {
    expect(itemScreen).toContain('elsewhere: item.elsewhere,');
    expect(itemScreen).toContain('elsewhereUnavailableNote(item.elsewhere)');
    expect(itemScreen).toContain('if (rows.length === 0 && !unavailableNote) return null;');
  });

  it('decides the skip from the role the screen already holds (no extra role read)', () => {
    expect(itemScreen).toContain('const { role } = useRole();');
    expect(itemScreen).toContain('}, [id, router, role]);');
  });
});

describe('scan sheet (app/(drawer)/(tabs)/scan.tsx)', () => {
  const loader = between(
    scanScreen,
    'async function loadItemById(',
    'async function loadItemByValue(',
  );

  it('starts the read BEFORE the item read, and waits for it last', () => {
    const start = loader.indexOf('readItemElsewhere(supabase, id, role)');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(loader.indexOf(".from('inventory_items')"));
    expect(loader.indexOf('await elsewhereRead')).toBeGreaterThan(
      loader.indexOf(".from('item_stock_levels')"),
    );
  });

  it('gates the Rack row on complete holdings, and renders the row or the note', () => {
    expect(scanScreen).toContain('holdingsKnownInFull(item?.elsewhere) &&');
    expect(scanScreen).toContain('elsewhereRow(item.elsewhere)');
    expect(scanScreen).toContain('elsewhereUnavailableNote(item.elsewhere)');
    expect(scanScreen).toContain(
      '{elsewhereNote && <Text style={styles.locNote}>{elsewhereNote}</Text>}',
    );
  });

  it('a long value wraps inside its row instead of running off the sheet', () => {
    expect(scanScreen).toContain(
      "locValueFit: { flexShrink: 1, marginLeft: 12, textAlign: 'right' },",
    );
    expect(scanScreen).toContain('styles.locValueFit');
  });
});

describe('ONE caller of item_holdings_elsewhere on the phone', () => {
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }
  const root = path.resolve(__dirname, '../..');
  const files = [...sources(path.join(root, 'app')), ...sources(path.join(root, 'src'))];

  it('only src/lib/holdings-elsewhere.ts names the RPC', () => {
    const callers = files
      .filter((f) => codeOnly(readFileSync(f, 'utf8')).includes('item_holdings_elsewhere'))
      .map((f) => path.relative(root, f));
    expect(callers).toEqual(['src/lib/holdings-elsewhere.ts']);
  });

  it('...and that check can actually fail', () => {
    expect(
      codeOnly("supabase.rpc('item_holdings_elsewhere', {})").includes('item_holdings_elsewhere'),
    ).toBe(true);
    expect(codeOnly('// item_holdings_elsewhere').includes('item_holdings_elsewhere')).toBe(false);
  });
});
