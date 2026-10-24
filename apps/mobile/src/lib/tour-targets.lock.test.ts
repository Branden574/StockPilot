import { afterEach, describe, expect, it } from 'vitest';

import {
  NOTIFICATION_NOTICE_LOCK_ID,
  isAnyTourVisible,
  isAnyTourVisibleExcept,
  setTourVisible,
  subscribeTourVisibility,
} from './tour-targets';

/**
 * The one interruption slot (tour-targets.ts), with the tapped notification's
 * notice as a full member (review 4, 2026-10-24). iOS refuses to present a
 * sheet while another is on screen, and React Native 0.86 never asks again, so
 * the notice may not show over a tour's offer or run; once it shows, a tour's
 * Modal yields to it and What's New waits for it. The hooks read these same
 * functions through useSyncExternalStore (this suite has no renderer).
 */

const HOME_TOUR = 'home';

afterEach(() => {
  setTourVisible(HOME_TOUR, false);
  setTourVisible(NOTIFICATION_NOTICE_LOCK_ID, false);
});

describe('the notice is a full member of the interruption lock', () => {
  it("keeps the notice's place in the lock under the id it has always held", () => {
    expect(NOTIFICATION_NOTICE_LOCK_ID).toBe('notification-notice');
  });

  it('a tour on screen holds the slot against the notice', () => {
    expect(isAnyTourVisibleExcept(NOTIFICATION_NOTICE_LOCK_ID)).toBe(false);
    setTourVisible(HOME_TOUR, true);
    expect(isAnyTourVisibleExcept(NOTIFICATION_NOTICE_LOCK_ID)).toBe(true);
    setTourVisible(HOME_TOUR, false);
    expect(isAnyTourVisibleExcept(NOTIFICATION_NOTICE_LOCK_ID)).toBe(false);
  });

  it("the notice's own place never counts against it, and What's New still waits for it", () => {
    setTourVisible(NOTIFICATION_NOTICE_LOCK_ID, true);
    expect(isAnyTourVisibleExcept(NOTIFICATION_NOTICE_LOCK_ID)).toBe(false);
    // What's New asks isAnyTourVisible() before it opens.
    expect(isAnyTourVisible()).toBe(true);
    // A tour offer that comes up later is another holder.
    setTourVisible(HOME_TOUR, true);
    expect(isAnyTourVisibleExcept(NOTIFICATION_NOTICE_LOCK_ID)).toBe(true);
  });

  it('every change tells the subscribers (the hooks re-render on it), and a repeat tells nobody', () => {
    let calls = 0;
    const off = subscribeTourVisibility(() => {
      calls += 1;
    });
    setTourVisible(NOTIFICATION_NOTICE_LOCK_ID, true);
    setTourVisible(NOTIFICATION_NOTICE_LOCK_ID, true);
    setTourVisible(NOTIFICATION_NOTICE_LOCK_ID, false);
    off();
    setTourVisible(NOTIFICATION_NOTICE_LOCK_ID, true);
    expect(calls).toBe(2);
  });
});
