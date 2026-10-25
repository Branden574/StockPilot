import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INTERRUPTED_RUN_PREFIX,
  INTERRUPTED_RUN_TTL_MS,
  purgeInterruptedRuns,
} from '@/lib/interrupted-run';
import {
  fakeBroadcastChannels,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

import { InterruptedRunExpiry } from './interrupted-run-expiry';

/**
 * What an interrupted run kept in this tab (lib/interrupted-run: a new
 * procedure's id, a Sage 50 import's summary with rows of its errors) is no
 * longer handed out an hour after the run's last step, and from then on it is
 * not kept either. A session that expired leaves the tab on the sign-in page,
 * which knows no account, so the app shell's sweep never runs there: this
 * component, in the root layout, removes such records on every page.
 */

const MINUTE = 60_000;
const NOW = 10_000_000;

function store(kind: string, account: { userId: string; organizationId: string }, ageMs: number) {
  sessionStorage.setItem(
    `${INTERRUPTED_RUN_PREFIX}${kind}`,
    JSON.stringify({ v: 1, ...account, at: NOW - ageMs, payload: { id: 'p-1' } }),
  );
}

afterEach(() => {
  cleanup();
  purgeInterruptedRuns();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('InterruptedRunExpiry', () => {
  it('as a page loads, removes every record over an hour old or unreadable, whoever its account, and keeps fresh ones', () => {
    vi.useFakeTimers({ now: NOW });
    store('mine-fresh', { userId: 'user-1', organizationId: 'org-1' }, 59 * MINUTE);
    store('other-fresh', { userId: 'user-2', organizationId: 'org-9' }, 5 * MINUTE);
    store('mine-old', { userId: 'user-1', organizationId: 'org-1' }, 61 * MINUTE);
    store('other-old', { userId: 'user-2', organizationId: 'org-9' }, 3 * INTERRUPTED_RUN_TTL_MS);
    sessionStorage.setItem(`${INTERRUPTED_RUN_PREFIX}unreadable`, '{not json');
    sessionStorage.setItem(UNRELATED_KEY, 'kept');

    const { container } = render(<InterruptedRunExpiry />);

    expect(container).toBeEmptyDOMElement();
    expect(interruptedRunKeys()).toEqual([
      `${INTERRUPTED_RUN_PREFIX}mine-fresh`,
      `${INTERRUPTED_RUN_PREFIX}other-fresh`,
    ]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('while the page stays open, removes each record at its hour', () => {
    vi.useFakeTimers({ now: NOW });
    store('mine-fresh', { userId: 'user-1', organizationId: 'org-1' }, 40 * MINUTE);

    render(<InterruptedRunExpiry />);
    vi.advanceTimersByTime(19 * MINUTE);
    expect(interruptedRunKeys()).toEqual([`${INTERRUPTED_RUN_PREFIX}mine-fresh`]);

    vi.advanceTimersByTime(2 * MINUTE);
    expect(interruptedRunKeys()).toEqual([]);
  });
});

/**
 * The tabs of a browser share its sign-in (the session cookies), so a sign-out
 * in one ends it in all of them. Review of round 2's repair: "Sign out and
 * back in" on an error card, or Delete my account, in one tab left every
 * other tab's records, and a run going there kept recording. Every sign-out
 * now tells the other tabs (lib/interrupted-run), and this component, on every
 * page, is where a tab hears it.
 */
describe('InterruptedRunExpiry: a sign-out in another tab of this browser', () => {
  it('removes what this tab kept', () => {
    const tabs = fakeBroadcastChannels();
    seedInterruptedRuns();
    render(<InterruptedRunExpiry />);
    expect(interruptedRunKeys()).toHaveLength(2);

    tabs.otherTab().postMessage({ type: 'purge' });
    tabs.deliver();

    expect(interruptedRunKeys()).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('keeps no channel open on a page with nothing to remove, and none once it unmounts', () => {
    const tabs = fakeBroadcastChannels();
    const empty = render(<InterruptedRunExpiry />);
    expect(tabs.openHere()).toBe(0);
    empty.unmount();

    seedInterruptedRuns();
    const { unmount } = render(<InterruptedRunExpiry />);
    expect(tabs.openHere()).toBe(1);
    unmount();
    expect(tabs.openHere()).toBe(0);

    // Unmounted, it removes nothing.
    tabs.otherTab().postMessage({ type: 'purge' });
    tabs.deliver();
    expect(interruptedRunKeys()).toHaveLength(2);
  });
});
