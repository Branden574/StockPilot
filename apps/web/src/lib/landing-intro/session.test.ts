// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasSeenIntro, INTRO_SEEN_KEY, markIntroSeen } from './session';

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('intro session lane', () => {
  it('uses the exact documented key', () => {
    expect(INTRO_SEEN_KEY).toBe('stockpilot:intro-seen:v1');
  });

  it('treats an unseen session as a first visit', () => {
    expect(hasSeenIntro()).toBe(false);
  });

  it('remembers within the session once marked', () => {
    markIntroSeen();
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBe('1');
    expect(hasSeenIntro()).toBe(true);
  });

  it('never touches localStorage — the flag must not outlive the session', () => {
    markIntroSeen();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
  });

  it('degrades to first-visit when storage throws (private mode)', () => {
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => hasSeenIntro()).not.toThrow();
    expect(hasSeenIntro()).toBe(false);
  });

  it('never throws when writing is denied', () => {
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => markIntroSeen()).not.toThrow();
  });
});
