import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The purchase orders list's fold (P69-1). Under 640px of card, po-list.css
 * lays the table's own cells out as the reference's two-line row, so each
 * value is drawn once; the fold used to be a second, hidden copy of the
 * status, the supplier, the dates and the line count in every row. These pins
 * keep what makes that work:
 *  - it is imported once, by the table, outside every cascade layer (so the
 *    cells' utility classes give way to it), and every rule is inside the
 *    container query and scoped to table[data-slot='po-list'], so the wide
 *    table and every other table are the plain table;
 *  - nothing is taken out of the accessibility tree: what the fold leaves out
 *    and the folded columns' headers are out of sight, never display: none;
 *  - the words only the fold shows are generated there, and each "·" is tied
 *    to the part before it by a no-break space (a nowrap separator let
 *    WebKit draw a line past the fold's edge instead of wrapping it);
 *  - the spacing that puts every value where the folded copy drew it.
 */

const HERE = __dirname;
const SRC = join(HERE, '..', '..');
const css = readFileSync(join(HERE, 'po-list.css'), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the one @container block, and what lies outside it. */
function containerBlock(): { query: string; body: string; outside: string } {
  const at = rules.indexOf('@container');
  const open = rules.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < rules.length; i += 1) {
    if (rules[i] === '{') depth += 1;
    else if (rules[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return {
    query: rules.slice(at, open).trim(),
    body: rules.slice(open + 1, end),
    outside: rules.slice(0, at) + rules.slice(end + 1),
  };
}

/** A selector list split at its top-level commas (not those inside :is() or :nth-child()). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Each rule in the block as [its selectors, its declarations]. */
function ruleList(): Array<{ selectors: string[]; decls: Record<string, string> }> {
  const { body } = containerBlock();
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: splitSelectors(m[1]!),
    decls: Object.fromEntries(
      m[2]!
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const colon = d.indexOf(':');
          return [
            d.slice(0, colon).trim(),
            d
              .slice(colon + 1)
              .replace(/\s+/g, ' ')
              .trim(),
          ];
        }),
    ),
  }));
}

function ruleFor(selector: string) {
  const found = ruleList().find((r) => r.selectors.includes(selector));
  expect(found, selector).toBeDefined();
  return found!.decls;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const ROW = "table[data-slot='po-list'] > tbody > tr";

describe('components/po/po-list.css', () => {
  it('is imported once, by the list table, and sits outside every cascade layer', () => {
    const importers = walk(SRC).filter((p) =>
      /['"]\.\/po-list\.css['"]|components\/po\/po-list\.css['"]/.test(readFileSync(p, 'utf8')),
    );
    expect(importers.map((p) => p.slice(SRC.length + 1))).toEqual([
      'components/po/po-instant-table.tsx',
    ]);
    expect(rules).not.toMatch(/@layer/);
  });

  it('holds every rule inside the 640px container query, scoped to the list table', () => {
    const { query, outside } = containerBlock();
    expect(query).toBe('@container (width < 640px)');
    expect(outside.trim()).toBe('');
    const list = ruleList();
    expect(list.length).toBeGreaterThan(10);
    for (const { selectors } of list)
      for (const s of selectors) expect(s.startsWith("table[data-slot='po-list']"), s).toBe(true);
  });

  it('takes nothing out of the accessibility tree: what the fold leaves out is only out of sight', () => {
    expect(rules).not.toMatch(/display:\s*none|visibility:\s*hidden|content-visibility/);
    const hidden = ruleList().find((r) => r.selectors.includes(`${ROW} > td[data-none]`));
    expect(hidden?.selectors).toContain(
      "table[data-slot='po-list'] > thead > tr > th:nth-child(n + 2):nth-child(-n + 6)",
    );
    expect(hidden?.decls).toMatchObject({
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
    });
  });

  it('generates the words only the fold shows, and ties each "·" to the part before it', () => {
    expect(ruleFor(`${ROW} > td:nth-child(4):not([data-none])::before`)).toEqual({
      content: "'Placed '",
    });
    expect(ruleFor(`${ROW} > td:nth-child(5)::before`)).toEqual({ content: "'Expected '" });
    expect(ruleFor(`${ROW} > td:nth-child(6)::after`)).toEqual({ content: "' lines'" });
    expect(ruleFor(`${ROW} > td:nth-child(6)[data-one]::after`)).toEqual({ content: "' line'" });
    // A no-break space, not a nowrap box: no line starts with "·", and WebKit
    // wraps the part instead of drawing it past the fold's edge.
    expect(ruleFor(`${ROW} > td:is(:nth-child(2), :nth-child(4)):not([data-none])::after`)).toEqual(
      { content: "'\\00a0·'" },
    );
  });

  it('orders line 1, its end, then the parts, with the number 10px from the status', () => {
    const row = ruleFor(ROW);
    expect(row).toMatchObject({
      display: 'flex',
      'flex-wrap': 'wrap',
      'align-items': 'center',
      padding:
        'calc(var(--row-py) - 2px) calc(var(--po-total-ch) * (1ch - 0.005em) + 88px) var(--row-py) 16px',
    });
    // The lines touch: no gap between them; the 2px above and below line 1's
    // two items keep 4px between them when the status wraps, 2px to the parts.
    expect(row['row-gap']).toBeUndefined();
    expect(ruleFor(`${ROW}::after`)).toEqual({ content: "''", order: '3', 'flex-basis': '100%' });
    const number = ruleFor(`${ROW} > td:nth-child(1)`);
    const status = ruleFor(`${ROW} > td:nth-child(3)`);
    expect(number.order).toBe('1');
    expect(status).toEqual({ order: '2', 'margin-block': '2px' });
    expect(ruleFor(`${ROW} > td:nth-child(2)`).order).toBe('4');
    expect(ruleFor(`${ROW} > td:nth-child(4)`).order).toBe('5');
    expect(ruleFor(`${ROW} > td:nth-child(5)`).order).toBe('6');
    const [top, right, bottom, left] = number.margin!.split(' ');
    expect([top, bottom, left]).toEqual(['2px', '2px', '0']);
    const gap = Number.parseFloat(row['column-gap']!);
    const margin = Number.parseFloat(right!);
    // Both whole 64ths of a pixel (the unit browsers lay out in), adding up to 10px.
    expect(gap * 64).toBe(Math.round(gap * 64));
    expect(margin * 64).toBe(Math.round(margin * 64));
    expect(gap + margin).toBe(10);
  });
});
