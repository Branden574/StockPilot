import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderSchedHour, renderSchedTomorrow } from './schedule';
import { esEmailById } from '../es/registry';

import type { ScheduleReminderParams } from './schedule';

/**
 * Schedule family — render fidelity (calendar / amber clock states,
 * compact event card), registry subjects, PREFERENCE footer +
 * List-Unsubscribe, and stress inputs.
 */

const BASE: ScheduleReminderParams = {
  eventTitle: 'Cycle count — Aisle 4',
  dayWord: 'tomorrow',
  month: 'Jun',
  day: '11',
  dow: 'Thu',
  startTime: '9:00 AM',
  timeLabel: '9:00 AM – 11:00 AM',
  whenLabel: 'Thu, Jun 11, 9:00 AM',
  location: 'DCIV — Fresno',
  details: 'Full count of bin locations A4-01 through A4-36.',
  assignedToYou: true,
  firstName: 'Theo',
  recipientEmail: 'theo@l4l.example',
  scheduleUrl: 'https://stockpilotusa.com/dashboard/schedule/ev-1',
  urls: {
    manage: 'https://stockpilotusa.com/dashboard/settings/notifications',
    unsubscribe: 'https://stockpilotusa.com/dashboard/settings/notifications',
    support: 'https://stockpilotusa.com/support',
  },
};

describe('subjects and senders — byte-equal to the es registry', () => {
  it('sched-tmrw reproduces the registry subject (and the legacy cron subject)', () => {
    const r = renderSchedTomorrow(BASE);
    expect(r.subject).toBe('Reminder: Cycle count — Aisle 4 — tomorrow');
    expect(r.subject).toBe(esEmailById('sched-tmrw').subject({ event: BASE.eventTitle }));
    // Byte-identical to the string the cron always built for the 24h
    // horizon (`Reminder: ${title} — ${horizon}`) — subjects unchanged.
    expect(r.subject).toBe(`Reminder: ${BASE.eventTitle} — tomorrow`);
    expect(r.from).toBe('StockPilot <schedule@stockpilotusa.com>');
  });

  it('sched-hour reproduces the registry subject (and the legacy cron subject)', () => {
    const r = renderSchedHour(BASE);
    expect(r.subject).toBe('Reminder: Cycle count — Aisle 4 — in 1 hour');
    expect(r.subject).toBe(esEmailById('sched-hour').subject({ event: BASE.eventTitle }));
    expect(r.subject).toBe(`Reminder: ${BASE.eventTitle} — in 1 hour`);
    expect(r.from).toBe('StockPilot <schedule@stockpilotusa.com>');
  });
});

describe('preference footer + List-Unsubscribe', () => {
  it('renders the pref footer with manage / unsubscribe / support links', () => {
    for (const html of [renderSchedTomorrow(BASE).html, renderSchedHour(BASE).html]) {
      expect(html).toContain('>Manage email preferences</a>');
      expect(html).toContain('>Unsubscribe</a>');
      expect(html).toContain('>Support</a>');
      expect(html).toContain(
        'href="https://stockpilotusa.com/dashboard/settings/notifications"',
      );
      expect(html).toContain(
        'Unsubscribing stops this notification type only — security and account emails still arrive.',
      );
      expect(html).toContain('Schedule reminders are on for theo@l4l.example');
    }
  });

  it('returns a List-Unsubscribe header pointing at the settings page (digest precedent, no -Post)', () => {
    for (const r of [renderSchedTomorrow(BASE), renderSchedHour(BASE)]) {
      expect(r.headers).toEqual({
        'List-Unsubscribe': '<https://stockpilotusa.com/dashboard/settings/notifications>',
      });
      // No one-click POST endpoint exists for signed-in preferences —
      // advertising RFC 8058 one-click would be a lie.
      expect(r.headers['List-Unsubscribe-Post']).toBeUndefined();
    }
  });
});

describe('sched-tmrw', () => {
  it('composes info pill, calendar motion, and the full event card', () => {
    const { html } = renderSchedTomorrow(BASE);
    expect(html).toContain('class="infopill"');
    expect(html).toContain('&#9679; Tomorrow');
    expect(html).toContain('Cycle count — Aisle 4');
    expect(html).toContain('Tomorrow, 9:00 AM.');
    expect(html).toContain('https://stockpilotusa.com/email/motion/calendar@2x.gif');
    expect(html).toContain('width="528" height="194"');
    // Event card: date rail + time + meta + details row (non-compact).
    expect(html).toContain('>Jun</div>');
    expect(html).toContain('>11</div>');
    expect(html).toContain('>Thu</div>');
    expect(html).toContain('9:00 AM – 11:00 AM');
    expect(html).toContain('DCIV — Fresno &middot; Assigned to you');
    expect(html).toContain('Full count of bin locations A4-01 through A4-36.');
    expect(html).toContain('Open schedule &rarr;');
    expect(html).toContain('https://stockpilotusa.com/dashboard/schedule/ev-1');
  });

  it('uses the registry preheader when location exists and the recipient is the assignee', () => {
    const { html } = renderSchedTomorrow(BASE);
    expect(html).toContain('Thu, Jun 11, 9:00 AM · DCIV — Fresno. Assigned to you.');
  });

  it('renders the day word the SENDER computed, in all four places', () => {
    // Owner-reported 2026-08-24: a 2:30pm delivery announced as "tomorrow" at
    // 1:20pm the same afternoon. The template hardcoded "tomorrow" in the
    // subject, the badge, the headline and the plain-text part, so the caller
    // had no way to say otherwise. `dayWord` is now required (a missing one is
    // a type error, not a silent "tomorrow") and every one of those four places
    // reads from it — a fix applied to three of the four still ships the bug.
    const { html, subject, text } = renderSchedTomorrow({ ...BASE, dayWord: 'today' });
    expect(subject).toBe('Reminder: Cycle count — Aisle 4 — today');
    expect(html).toContain('Today');           // badge
    expect(html).toContain('Today, 9:00 AM.'); // headline
    expect(text).toContain('today');
    expect(html).not.toMatch(/tomorrow/i);
    expect(text).not.toMatch(/tomorrow/i);
    expect(subject).not.toMatch(/tomorrow/i);
  });

  it('carries a weekday through unchanged for an event further out', () => {
    const { html, subject } = renderSchedTomorrow({ ...BASE, dayWord: 'Thursday' });
    expect(subject).toBe('Reminder: Cycle count — Aisle 4 — Thursday');
    expect(html).toContain('Thursday, 9:00 AM.');
  });

  it('drops "Assigned to you" for manager recipients (the claim would be false)', () => {
    const { html, text } = renderSchedTomorrow({ ...BASE, assignedToYou: false });
    expect(html).not.toContain('Assigned to you');
    expect(html).toContain('a heads-up for this event');
    expect(text).not.toContain('Assigned to you');
  });

  it('degrades elegantly with no location and no details', () => {
    const { html } = renderSchedTomorrow({ ...BASE, location: null, details: null });
    expect(html).not.toContain('undefined');
    expect(html).not.toMatch(/\bnull\b/);
    expect(html).toContain('Thu, Jun 11, 9:00 AM. Assigned to you.');
    expect(html).toContain('a heads-up for your assigned event. Details below');
  });

  it('falls back to "Hi —" when the first name is missing', () => {
    const { html, text } = renderSchedTomorrow({ ...BASE, firstName: null });
    expect(html).toContain('Hi &mdash; a heads-up');
    expect(text).toContain('Hi — a heads-up');
  });
});

describe('sched-hour', () => {
  it('composes the amber warn state with clock motion and a COMPACT event card', () => {
    const { html } = renderSchedHour(BASE);
    expect(html).toContain('class="warnpill"');
    expect(html).toContain('&#9679; Starts in 1 hour');
    expect(html).toContain('Starting soon.');
    expect(html).toContain('9:00 AM &middot; DCIV — Fresno.');
    expect(html).toContain('https://stockpilotusa.com/email/motion/clock@2x.gif');
    // Compact card: no details row even though details exist.
    expect(html).not.toContain('Full count of bin locations');
    expect(html).toContain('starts in an hour.');
    // Amber = warn token pair on the pill.
    expect(html).toContain('background:#f0e7d2');
    expect(html).toContain('color:#7a5a1f');
  });

  it('preheader follows the registry shape with optional parts', () => {
    expect(renderSchedHour(BASE).html).toContain('Starts 9:00 AM &middot; DCIV — Fresno.');
    expect(renderSchedHour({ ...BASE, location: null }).html).toContain('Starts 9:00 AM.');
  });
});

describe('stress + safety', () => {
  it('escapes hostile titles and locations', () => {
    const { html, subject } = renderSchedHour({
      ...BASE,
      eventTitle: '<img src=x onerror=alert(1)> & "count"',
      location: '<script>alert(2)</script>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).toContain('&lt;script&gt;');
    // Subject is a header, not HTML — raw text is correct there.
    expect(subject).toBe('Reminder: <img src=x onerror=alert(1)> & "count" — in 1 hour');
  });

  it('long event titles and locations render without leaking placeholders', () => {
    const { html } = renderSchedTomorrow({
      ...BASE,
      eventTitle:
        'Quarterly wall-to-wall physical inventory count with cross-dock verification and shrink reconciliation — all zones',
      location:
        'Distribution Center IV — North Fresno Annex, Building C, Mezzanine Level 2, Staging Lane 14',
    });
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('{{');
  });

  it('templates are deterministic — no Date.now/new Date in the family code', () => {
    const src = readFileSync(path.resolve(__dirname, 'schedule.ts'), 'utf8');
    // Strip comments (the module docstring documents the rule itself).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bDate\.now\b/);
    expect(code).not.toMatch(/\bnew Date\b/);
  });

  it('stays under the 102KB Gmail clip budget', () => {
    expect(() => renderSchedTomorrow(BASE)).not.toThrow();
    expect(() => renderSchedHour(BASE)).not.toThrow();
  });
});
