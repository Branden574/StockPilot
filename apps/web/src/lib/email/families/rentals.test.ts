import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  renderRentalOut,
  renderRentalOverdue,
  renderRentalReturned,
} from './rentals';
import { esEmailById } from '../es/registry';

import type {
  RentalBaseParams,
  RentalOutParams,
  RentalOverdueParams,
  RentalReturnedParams,
} from './rentals';

/**
 * Rentals family — render fidelity, footer POLICY (essential, per the
 * "rental classification decision"), stress inputs, and weight budget.
 */

const BASE: RentalBaseParams = {
  firstName: 'Theo',
  borrowerName: 'Theo Marsh',
  borrowerEmail: 'theo@l4l.example',
  orgName: 'L4L North Region',
  location: 'DCIV — Fresno',
  items: [{ name: 'Handheld Scanner Z-220', qty: 2, sku: 'AST-0142' }],
  checkedOutAt: 'Jun 2, 10:15 AM',
  due: 'Jun 9, 2026',
  dueShort: 'Jun 9',
  viewUrl: 'https://stockpilotusa.com/dashboard/rentals/r-1',
  urls: {
    support: 'https://stockpilotusa.com/support',
    privacy: 'https://stockpilotusa.com/privacy',
    terms: 'https://stockpilotusa.com/terms',
  },
};

const OUT: RentalOutParams = {
  ...BASE,
  conditionNote: 'Both units charged and bagged. Cradle included.',
};
const RETURNED: RentalReturnedParams = { ...BASE, returnedAt: 'Jun 8, 4:05 PM' };
const OVERDUE: RentalOverdueParams = { ...BASE, overdueDays: 4, today: 'Jun 13, 2026' };

function assertNoLeakage(html: string): void {
  expect(html).not.toMatch(/undefined/);
  expect(html).not.toMatch(/\bnull\b/);
  expect(html).not.toMatch(/\{\{/);
  // Raw UUIDs never render (ids live only inside URLs, and these params
  // carry none).
  expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
}

describe('subjects and senders — byte-equal to the es registry', () => {
  it('rental-out', () => {
    const r = renderRentalOut(OUT);
    expect(r.subject).toBe('Your rental is checked out');
    expect(r.subject).toBe(esEmailById('rental-out').subject({}));
    expect(r.from).toBe('StockPilot <rentals@stockpilotusa.com>');
  });

  it('rental-returned', () => {
    const r = renderRentalReturned(RETURNED);
    expect(r.subject).toBe('Thanks — your rental has been returned');
    expect(r.subject).toBe(esEmailById('rental-returned').subject({}));
    expect(r.from).toBe('StockPilot <rentals@stockpilotusa.com>');
  });

  it('rental-overdue', () => {
    const r = renderRentalOverdue(OVERDUE);
    expect(r.subject).toBe('Reminder: your rental is overdue');
    expect(r.subject).toBe(esEmailById('rental-overdue').subject({}));
    expect(r.from).toBe('StockPilot <rentals@stockpilotusa.com>');
  });

  it('keeps the rec: refined subjects as registry comments, unimplemented', () => {
    const registrySrc = readFileSync(
      path.resolve(__dirname, '../es/registry.ts'),
      'utf8',
    );
    // The refinements exist as comments awaiting product sign-off…
    expect(registrySrc).toContain("// rec: 'Scanner Z-220 checked out — due back Jun 9'");
    expect(registrySrc).toContain("// rec: 'Scanner Z-220 was due Jun 9 — please return it'");
    // …and are NOT what renders.
    expect(renderRentalOut(OUT).subject).not.toContain('due back');
    expect(renderRentalOverdue(OVERDUE).subject).not.toContain('please return it');
  });
});

describe('footer policy — ESSENTIAL (rental classification decision)', () => {
  const renders = () => [
    renderRentalOut(OUT).html,
    renderRentalReturned(RETURNED).html,
    renderRentalOverdue(OVERDUE).html,
  ];

  it('renders the essential footer links, never an unsubscribe or manage link', () => {
    for (const html of renders()) {
      expect(html).toContain('>Support</a>');
      expect(html).toContain('>Privacy</a>');
      expect(html).toContain('>Terms</a>');
      // No preference footer: rentals have no preference backend, and a
      // link to a control that doesn't exist is a broken promise.
      expect(html).not.toContain('Unsubscribe');
      expect(html).not.toContain('Manage email preferences');
      expect(html).not.toContain('/dashboard/settings/notifications');
    }
  });

  it('carries an honest delivery reason (org + borrower email)', () => {
    for (const html of renders()) {
      expect(html).toContain('You&rsquo;re getting this because a rental from');
      expect(html).toContain('L4L North Region');
      expect(html).toContain('theo@l4l.example');
    }
  });

  it('the family source carries the policy flag referencing the rental classification decision', () => {
    const src = readFileSync(path.resolve(__dirname, 'rentals.ts'), 'utf8');
    expect(src).toContain('rental classification decision');
    // And the dispatcher repeats it so nobody adds headers/links there.
    const dispatcherSrc = readFileSync(path.resolve(__dirname, '../rentals.ts'), 'utf8');
    expect(dispatcherSrc).toContain('rental classification decision');
  });
});

describe('rental-out', () => {
  it('composes pill, headline, tag motion hero, asset card, condition banner, CTA', () => {
    const { html } = renderRentalOut(OUT);
    expect(html).toContain('class="infopill"');
    expect(html).toContain('&#9679; Checked out');
    expect(html).toContain('Handheld Scanner Z-220 is yours.');
    expect(html).toContain('Due back Jun 9.');
    expect(html).toContain('https://stockpilotusa.com/email/motion/tag@2x.gif');
    expect(html).toContain('width="528" height="194"');
    expect(html).toContain('alt="Rental tag: Handheld Scanner Z-220 checked out — due back Jun 9, 2026"');
    expect(html).toContain('Asset AST-0142');
    expect(html).toContain('&times;2');
    expect(html).toContain('Condition at checkout');
    expect(html).toContain('Both units charged and bagged. Cradle included.');
    expect(html).toContain('View rental &rarr;');
    expect(html).toContain('https://stockpilotusa.com/dashboard/rentals/r-1');
    assertNoLeakage(html);
  });

  it('omits the condition banner when there are no checkout notes', () => {
    const { html } = renderRentalOut({ ...OUT, conditionNote: null });
    expect(html).not.toContain('Condition at checkout');
  });

  it('omits the CTA for external borrowers (no public rental surface)', () => {
    const { html, text } = renderRentalOut({ ...OUT, viewUrl: null });
    expect(html).not.toContain('View rental');
    expect(html).not.toContain('/dashboard/rentals/');
    expect(text).not.toContain('View rental');
  });

  it('falls back to "Hi —" when the first name is missing', () => {
    const { html, text } = renderRentalOut({ ...OUT, firstName: null });
    expect(html).toContain('Hi &mdash; everything below');
    expect(text).toContain('Hi — everything below');
  });

  it('renders multi-line rentals as an item table + detail grid (no one-asset card)', () => {
    const { html } = renderRentalOut({
      ...OUT,
      items: [
        { name: 'Handheld Scanner Z-220', qty: 2, sku: 'AST-0142' },
        { name: 'Charging Cradle', qty: 1, sku: null },
      ],
    });
    expect(html).toContain('Charging Cradle');
    expect(html).not.toContain('Asset AST-0142'); // asset-card exclusive line
    expect(html).toContain('AST-0142'); // SKU column instead
    expect(html).toContain('Checked out');
    expect(html).toContain('Due back');
  });

  it('escapes hostile merge values', () => {
    const { html } = renderRentalOut({
      ...OUT,
      items: [{ name: '<script>alert(1)</script>', qty: 1, sku: 'X&Y' }],
      orgName: 'Org <b>bold</b>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('survives long-value stress without leaking placeholders', () => {
    const long = 'Extremely Long Equipment Name That Wraps Multiple Lines '.repeat(6).trim();
    const { html } = renderRentalOut({
      ...OUT,
      orgName: 'The Longest Regional Organization Name In The Whole District '.repeat(3).trim(),
      location: 'Distribution Center IV — North Fresno Annex, Equipment Cage B-12',
      items: [{ name: long, qty: 240, sku: 'SKU-EXTREMELY-LONG-0042-B' }],
    });
    assertNoLeakage(html);
  });
});

describe('rental-returned', () => {
  it('composes check motion, returned asset card, and record CTA', () => {
    const { html } = renderRentalReturned(RETURNED);
    expect(html).toContain('class="okpill"');
    expect(html).toContain('&#9679; Returned');
    expect(html).toContain('Returned &mdash; thanks.');
    expect(html).toContain('All checked in.');
    expect(html).toContain('https://stockpilotusa.com/email/motion/check@2x.gif');
    expect(html).toContain('Jun 8, 4:05 PM');
    expect(html).toContain('View record &rarr;');
    assertNoLeakage(html);
  });

  it('preheader follows the registry shape (item ×qty checked in …)', () => {
    const { html } = renderRentalReturned(RETURNED);
    expect(html).toContain('Handheld Scanner Z-220 ×2 checked in Jun 8, 4:05 PM. All set.');
  });
});

describe('rental-overdue', () => {
  it('renders real dates and day counts from params — no manufactured urgency', () => {
    const { html } = renderRentalOverdue(OVERDUE);
    expect(html).toContain('class="errpill"');
    // Registry badge label verbatim (typographic middle dot).
    expect(html).toContain('&#9679; Overdue · 4 days');
    expect(html).toContain('Handheld Scanner Z-220 was due Jun 9.');
    expect(html).toContain('That was 4 days ago.');
    expect(html).toContain('Today is Jun 13, 2026');
    expect(html).toContain('Calendar days');
    expect(html).toContain('https://stockpilotusa.com/email/motion/clock-arc@2x.gif');
    expect(html).toContain('Review rental &rarr;');
    // No urgency theater: the words the design bans on negative states.
    expect(html.toLowerCase()).not.toContain('urgent');
    expect(html.toLowerCase()).not.toContain('immediately');
    expect(html.toLowerCase()).not.toContain('final notice');
    assertNoLeakage(html);
  });

  it('day-count math comes from params (1 day renders singular copy this module owns)', () => {
    const { html } = renderRentalOverdue({ ...OVERDUE, overdueDays: 1 });
    expect(html).toContain('That was 1 day ago.');
    expect(html).toContain('— 1 day ago.'); // preheader overdueFor
    // The registry badge builder is normative and interpolates the raw
    // number ("Overdue · 1 days") — flagged as a registry nit, asserted
    // here so a silent "fix" of normative copy gets noticed.
    expect(html).toContain('Overdue · 1 days');
  });

  it('templates are deterministic — no Date.now/new Date in the family code', () => {
    const src = readFileSync(path.resolve(__dirname, 'rentals.ts'), 'utf8');
    // Strip comments (the module docstring documents the rule itself).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bDate\.now\b/);
    expect(code).not.toMatch(/\bnew Date\b/);
  });

  it('omits the equipment-desk secondary CTA when no contact URL exists', () => {
    const { html } = renderRentalOverdue(OVERDUE);
    expect(html).not.toContain('Contact equipment desk');
    const withContact = renderRentalOverdue({
      ...OVERDUE,
      contactUrl: 'https://stockpilotusa.com/support',
    });
    expect(withContact.html).toContain('Contact equipment desk');
  });
});

describe('weight budget', () => {
  it('every rental render stays under the 102KB Gmail clip budget', () => {
    const heavy: RentalBaseParams = {
      ...BASE,
      items: Array.from({ length: 40 }, (_, i) => ({
        name: `Warehouse Equipment Item With A Deliberately Long Display Name ${i + 1}`,
        qty: i + 1,
        sku: `SKU-${String(i + 1).padStart(5, '0')}-LONG`,
      })),
    };
    // Renderers throw over budget (assertEmailWeight is called inside).
    expect(() => renderRentalOut({ ...heavy, conditionNote: OUT.conditionNote })).not.toThrow();
    expect(() => renderRentalReturned({ ...heavy, returnedAt: RETURNED.returnedAt })).not.toThrow();
    expect(() =>
      renderRentalOverdue({ ...heavy, overdueDays: 12, today: OVERDUE.today }),
    ).not.toThrow();
  });
});
