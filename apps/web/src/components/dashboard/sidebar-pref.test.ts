import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SIDEBAR_HIDDEN_COOKIE,
  isDesktopViewport,
  isSidebarToggleChord,
  isTypingTarget,
  parseSidebarHidden,
  sidebarCookieString,
} from './sidebar-pref';

afterEach(() => vi.restoreAllMocks());

describe('parseSidebarHidden', () => {
  it('is hidden only for exactly "1"', () => {
    expect(parseSidebarHidden('1')).toBe(true);
    expect(parseSidebarHidden('0')).toBe(false);
    expect(parseSidebarHidden('')).toBe(false);
    expect(parseSidebarHidden(undefined)).toBe(false);
    expect(parseSidebarHidden(null)).toBe(false);
    expect(parseSidebarHidden('true')).toBe(false);
  });
});

describe('sidebarCookieString', () => {
  it('persists "1" for a year when hidden', () => {
    const s = sidebarCookieString(true);
    expect(s).toContain(`${SIDEBAR_HIDDEN_COOKIE}=1`);
    expect(s).toContain('path=/');
    expect(s).toContain('max-age=31536000');
    expect(s).toContain('samesite=lax');
  });
  it('clears the cookie when shown', () => {
    const s = sidebarCookieString(false);
    expect(s).toContain(`${SIDEBAR_HIDDEN_COOKIE}=;`);
    expect(s).toContain('max-age=0');
  });
});

describe('isDesktopViewport', () => {
  it('mirrors matchMedia(min-width: 768px).matches', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: true, media: q } as MediaQueryList),
    );
    expect(isDesktopViewport()).toBe(true);
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: false, media: q } as MediaQueryList),
    );
    expect(isDesktopViewport()).toBe(false);
  });
});

describe('isSidebarToggleChord', () => {
  it('matches Cmd+\\ and Ctrl+\\ only', () => {
    expect(isSidebarToggleChord({ metaKey: true, ctrlKey: false, key: '\\' })).toBe(true);
    expect(isSidebarToggleChord({ metaKey: false, ctrlKey: true, key: '\\' })).toBe(true);
    expect(isSidebarToggleChord({ metaKey: false, ctrlKey: false, key: '\\' })).toBe(false);
    expect(isSidebarToggleChord({ metaKey: true, ctrlKey: false, key: 'k' })).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('detects text-entry elements', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
