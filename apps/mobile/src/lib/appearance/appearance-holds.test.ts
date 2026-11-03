import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { holdUpdatePrompt, trackWrite } from '../update-prompt-holds';
import {
  combineHolds,
  holdAppearanceAdoption,
  isAppearanceAdoptionHeld,
  subscribeAppearanceAdoptionHolds,
} from './adoption-holds';
import { appearanceAdoptionHolds } from './holds';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

/**
 * What holds a Design adopted from the account back from being drawn (round
 * 2, finding 10; item 32): the B44 update holds (sheets, alerts, photo
 * picks, drafts, writes in flight) and, for the appearance only, the Scan tab
 * and the cycle-count entry screens while they are focused.
 */
describe('the appearance-only holds', () => {
  it('count overlapping holds; each release is safe to call twice', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppearanceAdoptionHolds(listener);
    expect(isAppearanceAdoptionHeld()).toBe(false);
    const scan = holdAppearanceAdoption('scan');
    const count = holdAppearanceAdoption('count');
    expect(isAppearanceAdoptionHeld()).toBe(true);
    scan();
    scan();
    expect(isAppearanceAdoptionHeld()).toBe(true);
    count();
    expect(isAppearanceAdoptionHeld()).toBe(false);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

describe('the holds the controller is given', () => {
  it('combine: held while any source holds, and every source tells the subscriber', () => {
    const a = { held: false, fns: new Set<() => void>() };
    const b = { held: false, fns: new Set<() => void>() };
    const source = (s: typeof a) => ({
      isHeld: () => s.held,
      subscribe: (fn: () => void) => {
        s.fns.add(fn);
        return () => {
          s.fns.delete(fn);
        };
      },
    });
    const both = combineHolds(source(a), source(b));
    const listener = vi.fn();
    const unsubscribe = both.subscribe(listener);
    b.held = true;
    for (const fn of b.fns) fn();
    expect(both.isHeld()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(a.fns.size + b.fns.size).toBe(0);
  });

  it('the app’s holds are the update pop-up’s and the appearance-only ones', async () => {
    const holds = appearanceAdoptionHolds();
    const listener = vi.fn();
    const unsubscribe = holds.subscribe(listener);
    expect(holds.isHeld()).toBe(false);
    const sheet = holdUpdatePrompt('sheet');
    expect(holds.isHeld()).toBe(true);
    sheet();
    expect(holds.isHeld()).toBe(false);
    const scan = holdAppearanceAdoption('scan');
    expect(holds.isHeld()).toBe(true);
    scan();
    let finish!: () => void;
    const write = trackWrite(new Promise<void>((r) => (finish = r)));
    expect(holds.isHeld()).toBe(true);
    finish();
    await write;
    expect(holds.isHeld()).toBe(false);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(6);
    unsubscribe();
  });
});

describe('the screens that hold it while focused', () => {
  const MOBILE_ROOT = path.resolve(__dirname, '../../..');
  const flat = (file: string) =>
    readFileSync(path.join(MOBILE_ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s+/g, ' ');

  it.each([
    ['app/(drawer)/(tabs)/scan.tsx', 'scan'],
    ['app/cycle-count/[id].tsx', 'count'],
    ['app/cycle-count/scan/[id].tsx', 'count'],
    ['app/cycle-count/ai-scan/[id].tsx', 'count'],
  ])('%s', (file, reason) => {
    const src = flat(file);
    expect(src).toContain(
      "import { useHoldAppearanceAdoptionWhileFocused } from '@/lib/appearance/use-adoption-hold';",
    );
    expect(src).toContain(`useHoldAppearanceAdoptionWhileFocused('${reason}');`);
  });

  it('the hook takes the hold on focus and gives it back on blur', () => {
    const src = flat('src/lib/appearance/use-adoption-hold.ts');
    expect(src).toContain(
      'useFocusEffect(React.useCallback(() => holdAppearanceAdoption(reason), [reason]));',
    );
  });
});
