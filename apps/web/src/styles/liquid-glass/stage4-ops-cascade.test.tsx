// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PoReceivingProgress } from '@/components/po/po-receiving-glass';

import { cascaded, specificity } from './stage4-ops-cascade';

/**
 * THE CASCADE OF THE STAGE 4 OPERATIONS LANE'S GLASS RULES on real markup
 * (stage4-ops-cascade.ts). stage4-ops-board-values.test.ts reads the value
 * each rule declares; a rule can still lose on the element it is written
 * for, to another glass rule of higher specificity that also matches it: a
 * purchase order's expected day was written at 16 / 24, 600, and drew at
 * 28 / 34, 650, because the figures' `> span:nth-child(2)` rule out-ranked
 * its `> [data-glass=...]`. Here the lane's components are rendered under
 * the glass root and each element gets the value the cascade gives it. The
 * page-level checks (a cycle count's head and lines toolbar) are in that
 * page's page.glass.test.tsx, on the page itself.
 */

beforeEach(() => {
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-appearance');
  vi.unstubAllEnvs();
});

describe('the specificity the cascade ranks rules by', () => {
  it.each([
    ['h1', [0, 0, 1]],
    ['.a.b', [0, 2, 0]],
    ['#x .a', [1, 1, 0]],
    ["[data-glass='x'] > span:nth-child(2)", [0, 2, 1]],
    [":root[data-appearance='liquid-glass'] a", [0, 2, 1]],
    [':is(.a, #b) span', [1, 0, 1]],
    [':where(.a, #b) span', [0, 0, 1]],
    [':not([data-x]) > td:first-child', [0, 2, 1]],
    ['div:has(> [data-glass=y])::before', [0, 1, 2]],
    ['.\\@container > .max-w-\\[1040px\\]', [0, 2, 0]],
  ] as const)('%s is %j', (selector, want) => {
    expect(specificity(selector)).toEqual(want);
  });
});

describe('the cascade itself', () => {
  it('lets the more specific of two matching rules win, and the later of two equals', () => {
    const { container } = render(
      <div data-glass-page="ops" data-glass-view="purchase-order">
        <PoReceivingProgress
          status="ordered"
          lines={[{ quantityOrdered: 2, quantityReceived: 0 }]}
          expectedAt={null}
        />
      </div>,
    );
    const section = container.querySelector("[data-glass='po-progress']")!;
    // primitives.css draws nothing on it; po.css's rule wins on its own.
    expect(cascaded(section, 'padding', ['pages/ops.css', 'pages/po.css'])?.value).toBe('20px');
    // Without the page's file nothing styles it.
    expect(cascaded(section, 'padding', ['pages/ops.css'])).toBeUndefined();
  });
});

describe('a purchase order (Purchase-Order.dc.html receiving card)', () => {
  const FILES = ['pages/ops.css', 'pages/po.css'];

  function card() {
    const view = render(
      <div data-glass-page="ops" data-glass-view="purchase-order">
        <PoReceivingProgress
          status="partially_received"
          lines={[
            { quantityOrdered: 30, quantityReceived: 26 },
            { quantityOrdered: 20, quantityReceived: 10 },
          ]}
          expectedAt="2026-10-30"
        />
      </div>,
    );
    const q = (sel: string) => view.container.querySelector(sel)!;
    return {
      day: q("[data-glass='po-progress-day']"),
      received: q("[data-glass='po-progress-stat'] > span:nth-child(2)"),
    };
  }

  it('draws the expected day as the board does (.lg.strong: 16 / 24, 600, the body face), not as a 28 px figure', () => {
    const { day } = card();
    expect(day.textContent).toBe('Fri, Oct 30');
    expect(cascaded(day, 'font-size', FILES)?.value).toBe('16px');
    expect(cascaded(day, 'line-height', FILES)?.value).toBe('24px');
    expect(cascaded(day, 'font-weight', FILES)?.value).toBe('600');
    expect(cascaded(day, 'font-family', FILES)?.value).toBe('inherit');
    expect(cascaded(day, 'letter-spacing', FILES)?.value).toBe('0');
  });

  it('keeps the figures beside it at the board .stat-v (28 / 34, 650)', () => {
    const { received } = card();
    expect(received.textContent).toBe('36 of 50 units');
    expect(cascaded(received, 'font-size', FILES)?.value).toBe('28px');
    expect(cascaded(received, 'line-height', FILES)?.value).toBe('34px');
    expect(cascaded(received, 'font-weight', FILES)?.value).toBe('650');
  });
});
