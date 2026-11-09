// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Glass-only and classic-only elements (Liquid Glass plan 4.4, review finding
 * R2). The unit half: the elements never use the HTML `hidden` attribute (which
 * Tailwind's preflight hides with !important in @layer base, beyond the reach
 * of layer lg) and carry no class that sets `display` (an unlayered or later
 * rule would show them in classic), and a stateful leaf is never inside one.
 * The computed-display half (display:none in classic, a visible box in glass)
 * runs in Playwright on the lab with the compiled CSS.
 */

const SRC = join(__dirname, '..', '..');
const DISPLAY_CLASS =
  /(^|\s)(?:[\w-]+:)*(block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|table|hidden|sr-only)(\s|$)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

// An opening tag, read up to its closing `>`; the `=>` of an arrow function in
// a prop (onFocus={() => ...}) is part of the tag, not its end, or a tag with
// a handler before its data-glass-only (the sidebar's Place an order) would
// never be found.
const TAG = /<[\w.]+\s(?:=>|[^>])*?\bdata-(glass|classic)-only\b(?:=>|[^>])*>/g;

const ELEMENTS = walk(SRC).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(TAG)].map((m) => ({
    file: relative(SRC, file),
    tag: m[0],
  }));
});

describe('glass-only and classic-only elements', () => {
  it('never use the hidden attribute', () => {
    expect(ELEMENTS.filter((e) => /\shidden(\s|=|>)/.test(e.tag))).toEqual([]);
  });

  it('carry no class that sets display', () => {
    const offenders = ELEMENTS.filter((e) => {
      const cls = /className="([^"]*)"/.exec(e.tag)?.[1] ?? '';
      return DISPLAY_CLASS.test(cls);
    });
    expect(offenders).toEqual([]);
  });

  // plans/REVISION-DEFAULT.md item 22: the appearance menu in the external
  // shell's corner (no data action; tests/e2e/appearance/glass-only-allowlist.json).
  // Stage 3, items lane: the sidebar's tinted Place an order (a duplicate of
  // the Orders list's own Place order, behind the sidebar's Orders entry).
  // Stage 3, site lane: the sign-in shell's "Contact the team" link and the
  // span around its Security help link (public page links).
  // Stage 3, orders lane: the Orders list's phone cards (one list of links
  // to the rows' own orders) and the Export menu's icons, tab name and
  // sub-lines (three per item, words only); the order page's fulfilment
  // badge beside the status (words and an icon); the order page's
  // requester note, Classic-only in the main column (the page) and a
  // glass-only copy in the side column (words only, plan 4.6).
  // Stage 4, operations lane: a cycle count's fifth figure and its wide
  // progress bar (words and a bar from the summary the page loads); a
  // return's progress rail (words and marks from its status); a purchase
  // order's receiving summary and its four board line columns, with Classic's
  // "Received / ordered" column marked Classic-only in the page (figures and
  // words from the lines); a cycle count's status beside its title (the card
  // head's badge, which glass hides while the copy is drawn) and the board's
  // note on Expected in its lines toolbar (words only).
  // Stage 4, insights lane: the Reports hub's grouped tiles (the same links
  // as Classic's flat list, marked Classic-only in the page).
  // Each is on tests/e2e/appearance/glass-only-allowlist.json.
  it('are listed, so a new one is reviewed here first', () => {
    expect(ELEMENTS.map((e) => e.file)).toEqual([
      ...Array<string>(2).fill('app/(auth)/layout.tsx'),
      'app/(dashboard)/dashboard/orders/[id]/page.tsx',
      ...Array<string>(2).fill('app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx'),
      'app/(dashboard)/dashboard/reports/page.tsx',
      'components/auth/external-shell.tsx',
      ...Array<string>(4).fill('components/cycle-counts/count-glass-summary.tsx'),
      'components/dashboard/sidebar.tsx',
      'components/orders/order-fulfilment-badge.tsx',
      'components/orders/order-phone-cards.tsx',
      'components/orders/order-requester-note-aside.tsx',
      ...Array<string>(6).fill('components/orders/orders-export-menu.tsx'),
      ...Array<string>(9).fill('components/po/po-receiving-glass.tsx'),
      'components/reports/reports-hub-glass.tsx',
      'components/returns/return-progress-rail.tsx',
    ]);
  });
});
