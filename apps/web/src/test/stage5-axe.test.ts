import { describe, expect, it } from 'vitest';

import {
  addedByGlass,
  addedRules,
  AXE_TAGS,
  findings,
  severe,
  type AxeViolation,
} from '../../tests/e2e/appearance/axe';

/**
 * Plan 8.3-1: how a11y-axe.spec.ts judges axe-core's results. Glass may add
 * no violation the same route has not in Classic of the same theme, and no
 * glass look may have a serious or critical one.
 */

const v = (id: string, impact: AxeViolation['impact'], ...targets: string[]): AxeViolation => ({
  id,
  impact,
  help: id,
  nodes: targets.map((t) => ({ target: [t], html: '<b>record data never kept</b>' })),
});

describe('axe findings', () => {
  it('flattens one finding per node, sorted, without the node HTML', () => {
    const f = findings([v('label', 'critical', '#b', '#a'), v('color-contrast', 'serious', '.x')]);
    expect(f).toEqual([
      { rule: 'color-contrast', impact: 'serious', target: '.x' },
      { rule: 'label', impact: 'critical', target: '#a' },
      { rule: 'label', impact: 'critical', target: '#b' },
    ]);
    expect(JSON.stringify(f)).not.toContain('record data');
  });
  it('keeps the AA rule tags the plan asks for', () => {
    expect(AXE_TAGS).toEqual(expect.arrayContaining(['wcag2aa', 'wcag21aa', 'wcag22aa']));
  });
});

describe('glass against classic', () => {
  const classic = findings([
    v('region', 'moderate', 'main'),
    v('color-contrast', 'serious', '.badge'),
  ]);
  it('passes when glass has only what classic has', () => {
    expect(addedByGlass(classic, classic)).toEqual([]);
    expect(addedRules(classic, classic)).toEqual([]);
  });
  it('FAILS a violation glass adds (a new node, or a new rule)', () => {
    const glass = findings([
      v('region', 'moderate', 'main'),
      v('color-contrast', 'serious', '.badge', '.pane h2'),
      v('nested-interactive', 'serious', '.card'),
    ]);
    expect(addedByGlass(classic, glass).map((f) => `${f.rule} ${f.target}`)).toEqual([
      'color-contrast .pane h2',
      'nested-interactive .card',
    ]);
    expect(addedRules(classic, glass)).toEqual(['nested-interactive']);
  });
  it('picks the serious and critical findings', () => {
    expect(severe(classic).map((f) => f.rule)).toEqual(['color-contrast']);
  });
});
