import { act, render } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleMoment, ZonedTime, ZonedWords, consoleZoneNote } from './zoned-time';

/**
 * TIMES IN THE VIEWER'S ZONE on the console's security pages. Pinned: a time
 * is the instant in the zone the viewer chose, with that zone's short name at
 * that very instant (across the night the clocks go back, and east of UTC),
 * and the exact instant in UTC in its title and for screen readers; with no
 * zone chosen the server prints UTC; and the server's HTML hydrates in a
 * browser whose own zone is another without a mismatch. Made-up instants.
 */

const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
/** The browser's own zone, as Intl reports it. */
function browserZone(zone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...realResolved.call(this), timeZone: zone };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a time', () => {
  it('in Pacific, across the night the clocks go back: PDT then PST, each with its exact UTC', () => {
    const { container } = render(
      <>
        <ConsoleMoment at="2026-11-01T08:30:00Z" timeZone="America/Los_Angeles" />
        <ConsoleMoment at="2026-11-01T09:30:00Z" timeZone="America/Los_Angeles" />
      </>,
    );
    const [before, after] = [...container.querySelectorAll('time')];
    expect(before!.firstChild?.textContent).toBe('1 Nov 2026, 01:30 PDT');
    expect(after!.firstChild?.textContent).toBe('1 Nov 2026, 01:30 PST');
    expect(before).toHaveAttribute('title', '1 Nov 2026, 08:30 UTC');
    expect(after).toHaveAttribute('title', '1 Nov 2026, 09:30 UTC');
    expect(after).toHaveAttribute('dateTime', '2026-11-01T09:30:00.000Z');
    expect(after!.querySelector('.sr-only')?.textContent).toBe(' (1 Nov 2026, 09:30 UTC)');
  });

  it('east of UTC; and with no zone chosen, UTC, said once', () => {
    const { container } = render(
      <>
        <ConsoleMoment at="2026-11-23T21:58:00Z" timeZone="Europe/Berlin" />
        <ConsoleMoment at="2026-11-23T21:58:00Z" timeZone={null} />
        <ConsoleMoment at={null} timeZone="Europe/Berlin" />
      </>,
    );
    const [berlin, none] = [...container.querySelectorAll('time')];
    expect(berlin!.firstChild?.textContent).toBe('23 Nov 2026, 22:58 GMT+1');
    expect(berlin).toHaveAttribute('title', '23 Nov 2026, 21:58 UTC');
    expect(none!.textContent).toBe('23 Nov 2026, 21:58 UTC');
    expect(none).toHaveAttribute('title', '23 Nov 2026, 21:58 UTC');
    expect(none!.querySelector('.sr-only')).toBeNull();
    expect(container.textContent).toMatch(/—$/);
  });

  it('a sentence that names times carries their exact UTC; one in UTC says nothing twice', () => {
    const { container } = render(
      <>
        <ZonedWords
          at={[Date.parse('2026-11-23T20:00:00Z')]}
          text="Not updating since 12:00 PST."
        />
        <ZonedWords
          at={[Date.parse('2026-11-23T20:00:00Z')]}
          text="Not updating since 20:00 UTC."
        />
        <ZonedWords at={null} text="Paused." />
      </>,
    );
    const [pacific, utc] = [...container.querySelectorAll('span[title]')];
    expect(pacific).toHaveAttribute('title', '23 Nov 2026, 20:00 UTC');
    expect(pacific!.textContent).toBe(
      'Not updating since 12:00 PST. In UTC: 23 Nov 2026, 20:00 UTC.',
    );
    expect(utc!.textContent).toBe('Not updating since 20:00 UTC.');
    expect(container.textContent).toMatch(/Paused\.$/);
  });

  it("a table's note names the zone its times are in", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T06:00:00Z'));
    expect(consoleZoneNote('America/Los_Angeles')).toBe(
      'In Pacific Standard Time (America/Los_Angeles).',
    );
    vi.setSystemTime(new Date('2026-07-01T06:00:00Z'));
    expect(consoleZoneNote('America/Los_Angeles')).toBe(
      'In Pacific Daylight Time (America/Los_Angeles).',
    );
    expect(consoleZoneNote(null)).toBe('In UTC.');
  });
});

describe('no hydration mismatch', () => {
  it('the server HTML for a chosen zone is what the browser renders, in a browser of another zone', async () => {
    const tree = (
      <p>
        <ConsoleMoment at="2026-11-20T10:15:31Z" timeZone="America/Los_Angeles" />
        <ZonedTime at={Date.parse('2026-11-23T21:58:00Z')} shown="13:58 PST" />
        <ZonedWords at={[Date.parse('2026-11-23T21:58:00Z')]} text="As of 13:58 PST." />
      </p>
    );
    // On the server: its own zone is UTC.
    browserZone('UTC');
    const html = renderToString(tree);
    vi.restoreAllMocks();
    // In a browser in Tokyo.
    browserZone('Asia/Tokyo');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, tree, { onRecoverableError: (e) => recoverable.push(e) });
    });
    expect(recoverable).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    // Nothing was redrawn: the DOM is the server's, as the browser parsed it.
    const parsed = document.createElement('div');
    parsed.innerHTML = html;
    expect(container.innerHTML).toBe(parsed.innerHTML);
    expect(container.textContent).toContain('20 Nov 2026, 02:15 PST');
    container.remove();
  });
});
