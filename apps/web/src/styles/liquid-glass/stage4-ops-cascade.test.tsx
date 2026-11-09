// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from '@/components/dashboard/command-palette';
import {
  KeyboardShortcutsProvider,
  openKeyboardShortcutsOverlay,
} from '@/components/dashboard/keyboard-shortcuts';
import { PoReceivingProgress } from '@/components/po/po-receiving-glass';
import { RestockDestinationPicker } from '@/components/returns/restock-destination-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { GLASS_DIR } from './glass-css';
import { cascaded, matches, specificity, withoutTopLevelNot } from './stage4-ops-cascade';

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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/cycle-counts',
  useSearchParams: () => new URLSearchParams(),
}));

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

describe("a return's radio rows (Return-Detail.dc.html .choice and .rb)", () => {
  const FILES = ['pages/ops.css', 'pages/returns.css'];
  const at = (el: Element, prop: string) => cascaded(el, prop, FILES)?.value;

  function picker() {
    const line = {
      returnLineId: 'l1',
      itemId: 'item-1',
      quantity: 1,
      disposition: 'restock',
      applied: false,
      plan: null,
      case: 'single_source',
      notRecordedReason: null,
      sources: [
        {
          locationId: '00000000-0000-4000-8000-000000000031',
          name: '31-C',
          kind: 'rack',
          type: 'shelf',
          drawn: 1,
          restored: 0,
          remaining: 1,
          cap: 1,
          valid: true,
          reason: null,
          writable: true,
        },
      ],
      offerOriginal: true,
      offerSourceIds: [],
      preselect: 'original',
    } as never;
    const view = render(
      <div data-glass-page="ops" data-glass-view="return">
        <RestockDestinationPicker
          line={line}
          choice={{ disposition: 'restock', target: 'original' } as never}
          onChange={() => {}}
          itemLabel="Example shirt"
        />
      </div>,
    );
    const groups = view.container.querySelectorAll("[role='radiogroup']");
    return { disposition: groups[0]!, destination: groups[1]! };
  }

  // sp.css draws .choice twice: the base rule (the line 2 edge on the
  // surface) and the later "controls on glass" block, which wins on glass
  // (the field frost and its edge). The surface and line 2 are what the field
  // tokens resolve to only with reduced transparency or more contrast.
  it('draws each row as .choice on glass: 12 px radius, the field edge, the field frost, no ink ring', () => {
    const { disposition, destination } = picker();
    for (const row of [...disposition.children, ...destination.children]) {
      expect(at(row, 'border-radius')).toBe('12px');
      expect(at(row, 'border-color')).toBe('var(--lg-field-line)');
      expect(at(row, 'background-color')).toBe('var(--lg-field-fill)');
      expect(at(row, 'box-shadow')).toBe('none');
    }
  });

  it('draws each dot as .rb: 18 px, a 1.5 px edge (ink 3, for 3:1) on the surface', () => {
    const { disposition, destination } = picker();
    const dots = [disposition, destination].flatMap((g) => [
      ...g.querySelectorAll("input[type='radio']"),
    ]);
    expect(dots.length).toBeGreaterThanOrEqual(3);
    for (const dot of dots) {
      expect(at(dot, 'width')).toBe('18px');
      expect(at(dot, 'height')).toBe('18px');
      expect(at(dot, 'border')).toBe('1.5px solid var(--lg-ink-3)');
      expect(at(dot, 'background-color')).toBe('var(--lg-surface)');
    }
  });

  it('leaves a radio group outside a return alone', () => {
    const view = render(
      <div data-glass-page="ops" data-glass-view="returns">
        <div role="radiogroup">
          <label>
            <input type="radio" name="x" /> X
          </label>
        </div>
      </div>,
    );
    const row = view.container.querySelector("[role='radiogroup'] > label")!;
    expect(at(row, 'border-radius')).toBeUndefined();
  });
});

/**
 * The operations dialogs' title and description (ops.css: the 20 / 26 title
 * in ink, the description in ink 2 at 13 / 18) are scoped to an operations
 * page being on screen, through :root:has(), as the dialogs are portalled.
 * The shell's own dialogs (Keyboard shortcuts and the command palette, open
 * on every page) carry data-glass-role="shell-dialog" and keep the look they
 * have on every other page.
 */
describe("the operations dialogs' title and description", () => {
  const FILES = ['pages/ops.css'];
  const opsPage = () => <div data-glass-page="ops" data-glass-view="cycle-counts" />;

  it('draws a dialog opened on an operations page with the 20 px ink title and the ink 2 words', () => {
    const view = render(
      <>
        {opsPage()}
        <Dialog open>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Example title</DialogTitle>
              <DialogDescription>Example words.</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </>,
    );
    const title = view.getByRole('heading', { name: 'Example title' });
    expect(cascaded(title, 'font-size', FILES)?.value).toBe('20px');
    expect(cascaded(title, 'color', FILES)?.value).toBe('var(--lg-ink)');
    expect(cascaded(view.getByText('Example words.'), 'color', FILES)?.value).toBe(
      'var(--lg-ink-2)',
    );
  });

  it('leaves the Keyboard shortcuts dialog as it is on every other page', () => {
    const view = render(
      <>
        {opsPage()}
        <KeyboardShortcutsProvider />
      </>,
    );
    act(() => {
      openKeyboardShortcutsOverlay();
    });
    const title = view.getByRole('heading', { name: 'Keyboard shortcuts' });
    const words = title.nextElementSibling!;
    for (const [el, prop] of [
      [title, 'font-size'],
      [title, 'font-weight'],
      [title, 'color'],
      [words, 'font-size'],
      [words, 'color'],
    ] as const) {
      expect(cascaded(el, prop, FILES)?.file, `${el.tagName} ${prop}`).not.toBe('pages/ops.css');
    }
  });

  it("marks every dialog the shell opens (components/dashboard) as the shell's", () => {
    const dir = join(GLASS_DIR, '..', '..', 'components', 'dashboard');
    const opened = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
      .flatMap((f) =>
        [...readFileSync(join(dir, f), 'utf8').matchAll(/<DialogContent\b[^>]*>/gu)].map((m) => ({
          file: f,
          tag: m[0],
        })),
      );
    expect(opened.map((o) => o.file).sort()).toEqual([
      'command-palette.tsx',
      'keyboard-shortcuts.tsx',
    ]);
    for (const o of opened) {
      expect(o.tag, o.file).toContain('data-glass-role="shell-dialog"');
    }
  });

  it('leaves the command palette as it is on every other page', () => {
    const view = render(
      <>
        {opsPage()}
        <CommandPalette open onOpenChange={() => {}} />
      </>,
    );
    const dialog = view.getByRole('dialog');
    const title = dialog.querySelector('h2')!;
    const after = title.nextElementSibling!;
    for (const [el, prop] of [
      [title, 'font-size'],
      [title, 'color'],
      [after, 'font-size'],
      [after, 'color'],
      [after, 'line-height'],
    ] as const) {
      expect(cascaded(el, prop, FILES)?.file, `${el.tagName} ${prop}`).not.toBe('pages/ops.css');
    }
  });
});

describe('the matching the cascade relies on', () => {
  it('takes the outer :not(...) out, and leaves one inside another pseudo-class', () => {
    expect(withoutTopLevelNot(':is(div, li).a:not([data-glass])')).toBe(':is(div, li).a');
    expect(withoutTopLevelNot('a > :not(.x) b:has(:not(.y))')).toBe('a > * b:has(:not(.y))');
  });

  it('does not let happy-dom match :is(...).class:not(...) without the class', () => {
    const div = document.createElement('div');
    div.className = 'bg-card rounded-md border';
    document.body.append(div);
    const selector = ':is(div, li).bg-card.rounded-lg.border:not([data-glass])';
    expect(matches(div, selector)).toBe(false);
    div.className = 'bg-card rounded-lg border';
    expect(matches(div, selector)).toBe(true);
    div.setAttribute('data-glass', 'card');
    expect(matches(div, selector)).toBe(false);
    div.remove();
  });
});
