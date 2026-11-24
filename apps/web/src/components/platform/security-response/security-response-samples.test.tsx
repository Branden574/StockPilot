import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SECURITY_EVENT_SAMPLES_FAILED,
  SECURITY_EVENT_SAMPLES_REFUSED,
  SECURITY_EVENT_SAMPLES_WORDS as W,
  type SecurityEventSamplesEntry,
  type SecurityEventSamplesView,
} from '@stockpilot/core';

/**
 * "WHAT WAS ASKED FOR" IN THE HOW-TO-RESPOND PANEL.
 *
 * Security invariant. Pinned: the section reads once, when it mounts (the
 * panel opening), with the entry's kind, hour and country, and never again;
 * every path and query string is a text node in a monospace box, never a
 * link, never markup, never in a title, an href or an accessible name (a
 * script-shaped and a javascript:-shaped sample are on the page as text);
 * the region is named by its heading; "Show all" is one button that keeps
 * focus; a failed read, a refused one and an answer this build does not know
 * each say so in words, never as an empty list. Made-up paths only.
 */

const NOW = Date.parse('2026-11-24T10:15:05Z');

const h = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('@/server/actions/platform/security-event-samples', () => ({
  readSecurityEventSamplesAction: (...a: unknown[]) => h.action(...a),
}));

import { SecurityResponseSamples } from './security-response-samples';

const pair = (method: string, sample: string | null, events = 1) => ({ method, sample, events });
const target = (path: string, over: Record<string, unknown> = {}) => ({
  reason: 'env_file' as const,
  target: path,
  events: 4,
  pairs: [pair('GET', null, 3), pair('POST', 'debug=1')],
  pairsTruncated: false,
  ...over,
});

const view = (over: Partial<SecurityEventSamplesView> = {}): SecurityEventSamplesView => ({
  country: null,
  windowFrom: null,
  targets: [target('/backup/.env')],
  targetsTruncated: false,
  listedTargets: 1,
  moreThanListed: [],
  ...over,
});

const ENTRY: SecurityEventSamplesEntry = {
  reason: 'env_file',
  at: Date.parse('2026-11-24T09:42:00Z'),
  country: null,
  timeZone: 'America/Los_Angeles',
};

const section = () => screen.getByRole('region', { name: W.title });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.action.mockReset();
  h.action.mockResolvedValue({ ok: true, view: view() });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the read', () => {
  it("once, when it mounts, with the entry's kind, hour and country; loading first, in words", async () => {
    let answer!: (v: unknown) => void;
    h.action.mockReturnValueOnce(new Promise((r) => (answer = r)));
    render(<SecurityResponseSamples entry={{ ...ENTRY, country: 'NL' }} />);
    expect(h.action.mock.calls).toEqual([
      [{ reason: 'env_file', hour: '2026-11-24T09:00:00.000Z', country: 'NL' }],
    ]);
    expect(section()).toHaveAttribute('aria-busy', 'true');
    expect(section().textContent).toContain(W.loading);
    await act(async () => answer({ ok: true, view: view({ country: 'NL' }) }));
    expect(section()).toHaveAttribute('aria-busy', 'false');
    expect(section().textContent).toContain('/backup/.env');
    expect(section().textContent).toContain('From Netherlands only.');
    expect(h.action).toHaveBeenCalledTimes(1);
  });

  it("React's development check runs the effect twice: still one read", async () => {
    render(
      <React.StrictMode>
        <SecurityResponseSamples entry={ENTRY} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(section().textContent).toContain('/backup/.env'));
    expect(h.action).toHaveBeenCalledTimes(1);
  });

  it("the hour in the viewer's zone, its exact UTC for the pointer and for a screen reader", async () => {
    render(<SecurityResponseSamples entry={ENTRY} />);
    await waitFor(() => expect(section().textContent).toContain('/backup/.env'));
    expect(section().textContent).toContain(
      W.hourWindow('24 Nov 2026, 1:00 AM PST', '24 Nov 2026, 2:00 AM PST'),
    );
  });

  it('a card opened from the legend: every kind in the last 24 hours, each path with its kind', async () => {
    h.action.mockResolvedValueOnce({
      ok: true,
      view: view({
        targets: [target('/backup/.env'), target('/.git/config', { reason: 'git_dir' })],
        listedTargets: 2,
        moreThanListed: [{ reason: 'git_dir', events: 300, hours: 2 }],
      }),
    });
    render(
      <SecurityResponseSamples entry={{ reason: null, at: null, country: null, timeZone: null }} />,
    );
    expect(h.action.mock.calls).toEqual([[{ reason: null, hour: null, country: null }]]);
    await waitFor(() => expect(section().textContent).toContain('/.git/config'));
    expect(section().textContent).toContain(W.lastDay);
    expect(section().textContent).toContain('Request for a settings file');
    expect(section().textContent).toContain(
      W.overflow({ events: 300, hours: 2 }, false, 'Request for source control files'),
    );
  });

  it('an entry older than 7 days reads nothing and says why', () => {
    render(
      <SecurityResponseSamples entry={{ ...ENTRY, at: Date.parse('2026-11-16T09:00:00Z') }} />,
    );
    expect(h.action).not.toHaveBeenCalled();
    expect(section().textContent).toContain(W.tooOld);
    expect(section()).toHaveAttribute('aria-busy', 'false');
  });
});

describe('what it shows', () => {
  it('each path with its count, each method with its count, and the query under "What was sent"', async () => {
    render(<SecurityResponseSamples entry={ENTRY} />);
    await waitFor(() => expect(section().querySelector('[data-sample-target]')).not.toBeNull());
    const item = section().querySelector('[data-sample-target]')!;
    const pairs = [...item.querySelectorAll('[data-sample-pair]')];
    expect(pairs.map((p) => p.textContent)).toEqual([
      'GET3 requests',
      `POST1 request${W.sent}debug=1`,
    ]);
    expect(item.querySelector('[data-sample-path]')!.className).toMatch(/font-mono/);
    expect(item.querySelector('[data-sample-path]')!.className).toContain(
      '[overflow-wrap:anywhere]',
    );
    expect(item.querySelector('[data-sample-query]')!.className).toMatch(/font-mono/);
    expect(section().textContent).toContain(W.removed);
  });

  it('the first 5 paths, then "Show all N" as one button that keeps focus and says what it controls', async () => {
    const user = userEvent.setup();
    const seven = Array.from({ length: 7 }, (_, i) => target(`/site${i + 1}/.env`));
    h.action.mockResolvedValueOnce({ ok: true, view: view({ targets: seven, listedTargets: 7 }) });
    render(<SecurityResponseSamples entry={ENTRY} />);
    const button = await waitFor(() =>
      within(section()).getByRole('button', { name: 'Show all 7' }),
    );
    expect(section().querySelectorAll('[data-sample-target]')).toHaveLength(5);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(button.getAttribute('aria-controls')!);
    expect(list?.tagName).toBe('OL');
    await user.click(button);
    expect(section().querySelectorAll('[data-sample-target]')).toHaveLength(7);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button.textContent).toBe('Show the first 5');
    expect(document.activeElement).toBe(button);
    await user.click(button);
    expect(section().querySelectorAll('[data-sample-target]')).toHaveLength(5);
    expect(document.activeElement).toBe(button);
  });

  it("the contract's overflow line for the kind, with (all countries) under a country, and the truncation lines", async () => {
    h.action.mockResolvedValueOnce({
      ok: true,
      view: view({
        country: 'NL',
        targets: [target('/backup/.env', { pairsTruncated: true })],
        targetsTruncated: true,
        listedTargets: 120,
        moreThanListed: [
          { reason: 'env_file', events: 1200, hours: 1 },
          { reason: 'git_dir', events: 9, hours: 1 },
        ],
      }),
    });
    render(<SecurityResponseSamples entry={{ ...ENTRY, country: 'NL' }} />);
    await waitFor(() => expect(section().textContent).toContain('/backup/.env'));
    const text = section().textContent!;
    expect(text).toContain(W.overflow({ events: 1200, hours: 1 }, true));
    expect(text).toContain(
      '1,200 more requests of this kind were counted but not listed (all countries).',
    );
    // Only the entry's own kind.
    expect(section().querySelectorAll('[data-sample-overflow]')).toHaveLength(1);
    expect(text).toContain(W.pairsTruncated);
    expect(text).toContain(W.targetsTruncated(120, 1));
  });

  it('no sample: the fixed words, never an empty list', async () => {
    h.action.mockResolvedValueOnce({ ok: true, view: view({ targets: [], listedTargets: 0 }) });
    render(<SecurityResponseSamples entry={ENTRY} />);
    await waitFor(() => expect(section().textContent).toContain(W.none));
    expect(section().textContent).toContain(W.noneWhy);
    expect(section().querySelector('ol')).toBeNull();
  });

  it.each([
    ['could not check', SECURITY_EVENT_SAMPLES_FAILED, W.couldNotCheck],
    ['refused', SECURITY_EVENT_SAMPLES_REFUSED, W.refused],
    ['an answer this build does not know', { ok: true, view: { targets: [] } }, W.couldNotCheck],
    [
      'a path the table would refuse',
      { ok: true, view: view({ targets: [target('/x/someone@example.com')] }) },
      W.couldNotCheck,
    ],
  ])('%s: said in words', async (_what, answer, words) => {
    h.action.mockResolvedValueOnce(answer);
    render(<SecurityResponseSamples entry={ENTRY} />);
    await waitFor(() => expect(section().textContent).toContain(words));
    expect(section().querySelector('[data-sample-target]')).toBeNull();
  });

  it('a redirect (the session ended) shows no error: the router is already moving', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/signin;307;',
    });
    h.action.mockRejectedValueOnce(redirect);
    render(<SecurityResponseSamples entry={ENTRY} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(section().textContent).not.toContain(W.couldNotCheck);
    expect(section().textContent).toContain(W.loading);
  });

  it('a call that fails outright is could not check', async () => {
    h.action.mockRejectedValueOnce(new Error('made-up failure'));
    render(<SecurityResponseSamples entry={ENTRY} />);
    await waitFor(() => expect(section().textContent).toContain(W.couldNotCheck));
  });
});

describe('attacker-chosen text is data', () => {
  const SCRIPTISH = '/<script>made-up</script>/.env';
  const LINKISH = '/javascript:void(0)/.env';
  const QUERY = 'next=javascript:void(0)&x=<b>made-up</b>';

  it('a script-shaped and a javascript:-shaped sample are on the page as text, and nothing is a link', async () => {
    h.action.mockResolvedValueOnce({
      ok: true,
      view: view({
        targets: [target(SCRIPTISH), target(LINKISH, { pairs: [pair('GET', QUERY)] })],
        listedTargets: 2,
      }),
    });
    const before = document.querySelectorAll('script, img').length;
    render(<SecurityResponseSamples entry={ENTRY} />);
    await waitFor(() => expect(section().textContent).toContain(SCRIPTISH));
    const s = section();
    expect(s.textContent).toContain(LINKISH);
    expect(s.textContent).toContain(QUERY);
    const paths = [...s.querySelectorAll('[data-sample-path]')];
    expect(paths.map((p) => p.textContent)).toEqual([SCRIPTISH, LINKISH]);
    // Each is one text node: nothing in it was read as markup.
    for (const p of paths) {
      expect(p.childNodes).toHaveLength(1);
      expect(p.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    }
    expect(s.querySelector('[data-sample-query]')!.childNodes).toHaveLength(1);
    expect(s.querySelectorAll('a, [href], script, img, iframe')).toHaveLength(0);
    expect(document.querySelectorAll('script, img').length).toBe(before);
    // No attribute anywhere in the section carries the text.
    for (const el of [s, ...s.querySelectorAll('*')]) {
      for (const attr of el.getAttributeNames()) {
        const value = el.getAttribute(attr) ?? '';
        expect(value.includes('script') || value.includes('javascript'), `${attr}=${value}`).toBe(
          false,
        );
      }
    }
    // The region's name is its heading alone.
    expect(s).toHaveAccessibleName(W.title);
  });
});
