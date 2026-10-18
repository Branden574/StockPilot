import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DENSITY_COOKIE,
  NAV_COLLAPSED_COOKIE,
  SIDEBAR_HIDDEN_COOKIE,
  collapsedSectionsCookieString,
  defaultCollapsedSections,
  densityCookieString,
  isDesktopViewport,
  isSidebarToggleChord,
  isTypingTarget,
  parseCollapsedSections,
  parseDensity,
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
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('collapsed nav sections', () => {
  it('Admin starts collapsed for owners and admins only', () => {
    expect(defaultCollapsedSections('owner')).toEqual(['admin']);
    expect(defaultCollapsedSections('admin')).toEqual(['admin']);
    expect(defaultCollapsedSections('manager')).toEqual([]);
    expect(defaultCollapsedSections('staff')).toEqual([]);
    expect(defaultCollapsedSections('viewer')).toEqual([]);
  });

  it('parses the cookie: absent = never chose, empty = all open, unknown keys dropped', () => {
    expect(parseCollapsedSections(undefined)).toBeNull();
    expect(parseCollapsedSections(null)).toBeNull();
    expect(parseCollapsedSections('')).toEqual([]);
    expect(parseCollapsedSections('admin')).toEqual(['admin']);
    expect(parseCollapsedSections('inventory.admin.inventory')).toEqual(['inventory', 'admin']);
    expect(parseCollapsedSections('admin.fulfillment.<script>')).toEqual(['admin']);
  });

  it('persists the keys for a year, joined by "." (a cookie value may not hold a comma)', () => {
    const s = collapsedSectionsCookieString(['inventory', 'admin']);
    expect(s).toContain(`${NAV_COLLAPSED_COOKIE}=inventory.admin;`);
    expect(s).toContain('path=/');
    expect(s).toContain('max-age=31536000');
    expect(s).toContain('samesite=lax');
    // Every section open is a real choice, kept as an empty value.
    expect(collapsedSectionsCookieString([])).toContain(`${NAV_COLLAPSED_COOKIE}=;`);
    expect(collapsedSectionsCookieString([])).toContain('max-age=31536000');
  });
});

describe('density', () => {
  it('is compact only for exactly "compact"', () => {
    expect(parseDensity('compact')).toBe('compact');
    expect(parseDensity('comfortable')).toBe('comfortable');
    expect(parseDensity('')).toBe('comfortable');
    expect(parseDensity(undefined)).toBe('comfortable');
    expect(parseDensity('COMPACT')).toBe('comfortable');
  });

  it('persists compact for a year and clears the cookie for comfortable (the default)', () => {
    expect(densityCookieString('compact')).toContain(`${DENSITY_COOKIE}=compact;`);
    expect(densityCookieString('compact')).toContain('max-age=31536000');
    expect(densityCookieString('comfortable')).toContain(`${DENSITY_COOKIE}=;`);
    expect(densityCookieString('comfortable')).toContain('max-age=0');
  });
});
