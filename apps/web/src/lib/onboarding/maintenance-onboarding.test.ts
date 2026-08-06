import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALL_TOURS } from '@/app/(dashboard)/dashboard/help/page';

import { ANNOUNCEMENTS } from './announcements';
import * as toursModule from './tours';
import type { TourDefinition } from './types';
import { TOUR_ROUTES } from './workflows';

/**
 * Task 23 (Phase F close): pins the three onboarding registries a new
 * module wires into — TOUR_ROUTES (replay links), ANNOUNCEMENTS
 * (What's New, append-at-TOP), and every tour's copy against the brief
 * §20 status vocabulary (the maintenance email is PREPARED; the user
 * reviews and sends it — StockPilot never "sends", never claims a
 * "ticket [was] created", and never names the ticketing vendor "Zendesk"
 * in onboarding copy).
 *
 * `Object.values(toursModule)` sweeps every currently-registered
 * TourDefinition — not just the new maintenance tour — so this file
 * stays a live regression guard against the vocabulary leaking into any
 * FUTURE tour too, matching "every tour step's copy" in the brief.
 */
const ALL_DEFINED_TOURS = Object.values(toursModule) as TourDefinition[];

/**
 * Review-fix wave (Fix 2): the master §20 list (brief
 * `.superpowers/sdd/maintenance-requests-brief.md:280`) is `Ticket created`,
 * `Request submitted to Zendesk`, `DC4 notified`, `Andrew notified`,
 * `Ticket assigned`, `Email sent`. The original sweep used a bare `'sent'`
 * substring as a stand-in for `Email sent` — that's a false-positive
 * landmine (`'present'`, `'consent'`, `'sent to the maintenance team'` all
 * contain `sent` as a substring) and it also never caught `Ticket assigned`,
 * `Request submitted [to Zendesk]`, `DC4 notified`, or `Andrew notified`
 * individually. Every entry below is phrase-level (never a bare word) and
 * lowercase (the check lowercases `text` before matching, so casing in the
 * list itself is cosmetic — kept lowercase to make that explicit). `zendesk`
 * alone subsumes `Request submitted to Zendesk`'s vendor-naming half;
 * `request submitted` is kept as its own phrase so a rewritten sentence that
 * drops "to Zendesk" but keeps the unconfirmable "submitted" claim is still
 * caught.
 */
const FORBIDDEN_PHRASES = [
  'email sent',
  'ticket created',
  'ticket assigned',
  'request submitted',
  'zendesk',
  'dc4 notified',
  'andrew notified',
];

function forbiddenPhraseIn(text: string): string | undefined {
  const lower = text.toLowerCase();
  return FORBIDDEN_PHRASES.find((phrase) => lower.includes(phrase));
}

describe('maintenance-requests onboarding registries (Task 23)', () => {
  it('ALL_TOURS (Help & Learning replay list) includes the maintenance-requests tour', () => {
    expect(ALL_TOURS.some((t) => t.id === 'maintenance-requests')).toBe(true);
  });

  it('TOUR_ROUTES maps the maintenance-requests tour to /dashboard/maintenance', () => {
    expect(TOUR_ROUTES['maintenance-requests']).toBe('/dashboard/maintenance');
  });

  it('the maintenance-requests announcement is FIRST in ANNOUNCEMENTS, titled "Maintenance requests"', () => {
    expect(ANNOUNCEMENTS[0]?.id).toBe('maintenance-requests-2026-08');
    expect(ANNOUNCEMENTS[0]?.title).toBe('Maintenance requests');
  });

  it('the maintenance-requests announcement body is the exact brief copy', () => {
    expect(ANNOUNCEMENTS.find((a) => a.id === 'maintenance-requests-2026-08')?.body).toBe(
      'Report facilities and equipment issues from StockPilot. Your request is saved with a request number, and StockPilot prepares the complete Outlook email for you to review and send.',
    );
  });

  it('no announcement body contains a forbidden §20 phrase (email sent / ticket created / ticket assigned / request submitted / zendesk / dc4 notified / andrew notified)', () => {
    for (const a of ANNOUNCEMENTS) {
      expect(forbiddenPhraseIn(a.body), `announcement "${a.id}" body: "${a.body}"`).toBeUndefined();
    }
  });

  it('no tour step title or body contains a forbidden §20 phrase (email sent / ticket created / ticket assigned / request submitted / zendesk / dc4 notified / andrew notified)', () => {
    for (const tour of ALL_DEFINED_TOURS) {
      for (const step of tour.steps) {
        expect(
          forbiddenPhraseIn(step.title),
          `tour "${tour.id}" step title: "${step.title}"`,
        ).toBeUndefined();
        expect(
          forbiddenPhraseIn(step.body),
          `tour "${tour.id}" step body: "${step.body}"`,
        ).toBeUndefined();
      }
    }
  });
});

/**
 * Review-fix wave Fix 1: the onboarding registry pins above prove
 * MAINTENANCE_REQUESTS_TOUR is DATA (registered, routed, vocabulary-clean),
 * but nothing proved it was ever mounted on a page — Help's "Start" link
 * (`?tour=maintenance-requests`) pointed at `/dashboard/maintenance`, and
 * that page never rendered `<PageTour>` at all, so the tour could never
 * actually run. The onboarding suite is data-only (no DOM), so this follows
 * the repo's wiring-pin idiom instead (see
 * `apps/mobile/src/lib/maintenance-api.test.ts`'s "WIRING PINS for
 * app/(drawer)/maintenance.tsx" block, and
 * `apps/web/src/server/services/rack-shape.inventory-guard.test.ts`): a
 * `readFileSync` source-text assertion over the real page file.
 *
 * HONEST LIMITS OF THIS TECHNIQUE: this is a TEXT assertion over a source
 * string — nothing executes, no DOM renders, no React component actually
 * mounts. It catches the exact regression this fix wave found (a page that
 * never imports or renders `<PageTour>` at all) and a future edit that
 * removes the import or the JSX. It does NOT prove `<PageTour>` renders at
 * runtime without throwing, that `MAINTENANCE_REQUESTS_TOUR`'s step
 * selectors resolve against the real DOM, or that the tour is reachable via
 * the `?tour=maintenance-requests` deep link in a browser — verify that by
 * hand: load `/dashboard/maintenance?tour=maintenance-requests` in a
 * browser and confirm the spotlight tour actually starts.
 */
describe('apps/web maintenance/page.tsx mounts the onboarding tour (Task 23 review-fix wave, Fix 1)', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/(dashboard)/dashboard/maintenance/page.tsx'),
    'utf8',
  );

  it('imports MAINTENANCE_REQUESTS_TOUR from the tours registry', () => {
    expect(src).toMatch(
      /import\s*\{\s*MAINTENANCE_REQUESTS_TOUR\s*\}\s*from\s*['"]@\/lib\/onboarding\/tours['"]\s*;/,
    );
  });

  it('imports PageTour from the shared onboarding component', () => {
    expect(src).toMatch(
      /import\s*\{\s*PageTour\s*\}\s*from\s*['"]@\/components\/onboarding\/page-tour['"]\s*;/,
    );
  });

  it('renders <PageTour tour={MAINTENANCE_REQUESTS_TOUR} /> — the registered tour is actually mounted, not just imported', () => {
    expect(src).toMatch(/<PageTour\s+tour=\{MAINTENANCE_REQUESTS_TOUR\}\s*\/>/);
  });

  it('mounts the tour AFTER both the module-access gate and the permission redirect, so a disabled-module org never mounts it', () => {
    // Two separate early returns precede the render: checkModuleAccess's
    // <ModuleNotEnabled> branch, and the canSubmit/canReadAll redirect.
    // Checking each guard's TEXT occurs before the tour text isn't enough on
    // its own (dead code could sit anywhere) but it does catch the concrete
    // regression this fix addresses — <PageTour> being absent entirely — and
    // any future edit that hoists the render above either gate.
    const moduleGateIndex = src.indexOf("checkModuleAccess('maintenance_requests')");
    const permissionGuardIndex = src.indexOf('if (!canSubmit && !canReadAll)');
    const tourIndex = src.indexOf('<PageTour tour={MAINTENANCE_REQUESTS_TOUR} />');
    expect(moduleGateIndex).toBeGreaterThan(-1);
    expect(permissionGuardIndex).toBeGreaterThan(-1);
    expect(tourIndex).toBeGreaterThan(-1);
    expect(tourIndex).toBeGreaterThan(moduleGateIndex);
    expect(tourIndex).toBeGreaterThan(permissionGuardIndex);
  });
});
