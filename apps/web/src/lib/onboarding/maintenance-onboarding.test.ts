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

const FORBIDDEN_PHRASES = ['sent', 'ticket created', 'zendesk'];

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

  it('no announcement body contains a forbidden §20 phrase ("sent" / "ticket created" / "Zendesk")', () => {
    for (const a of ANNOUNCEMENTS) {
      expect(forbiddenPhraseIn(a.body), `announcement "${a.id}" body: "${a.body}"`).toBeUndefined();
    }
  });

  it('no tour step title or body contains a forbidden §20 phrase ("sent" / "ticket created" / "Zendesk")', () => {
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
