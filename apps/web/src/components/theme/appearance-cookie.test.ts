import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPEARANCE_SIGNED_OUT_EVENT,
  appearanceCookieString,
  chooseClassicFromRecovery,
  forgetAppearanceAccount,
  isCrashFallbackActive,
  markCrashFallbackShown,
  noteGlassCrash,
  readAppearanceCookie,
  readCrashFallback,
  readDeviceRecord,
  readDeviceRecordRaw,
  readLegacyTheme,
  readSyncRecordRaw,
  writeDeviceRecord,
  writeSyncRecord,
} from './appearance-cookie';

/** The web's appearance records (Liquid Glass plan 3.3) and the crash fallback (5.6). */

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_appearance=; path=/; max-age=0';
  document.documentElement.removeAttribute('data-appearance');
});

describe('the device cookie', () => {
  it('holds only the word, for a year, site-wide, lax, secure on https; never HttpOnly', () => {
    expect(appearanceCookieString('liquid-glass', true)).toBe(
      'sp_appearance=liquid-glass; path=/; max-age=31536000; samesite=lax; secure',
    );
    expect(appearanceCookieString('dark', false)).toBe(
      'sp_appearance=dark; path=/; max-age=31536000; samesite=lax',
    );
    expect(appearanceCookieString('dark', true)).not.toMatch(/httponly/i);
  });

  it('reads the cookie by exact name', () => {
    expect(readAppearanceCookie('a=1; sp_appearance=light; b=2')).toBe('light');
    expect(readAppearanceCookie('xsp_appearance=light')).toBeNull();
    expect(readAppearanceCookie('')).toBeNull();
  });
});

describe('the device record', () => {
  it('writes the cookie and the localStorage mirror, and reads them back through core’s parser', () => {
    writeDeviceRecord({ v: 1, mode: 'liquid-glass', lastClassic: 'light', anonAt: 5 });
    expect(document.cookie).toContain('sp_appearance=liquid-glass');
    expect(readDeviceRecord()).toEqual({
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'light',
      anonAt: 5,
    });
  });

  it('falls back to the cookie when localStorage holds nothing', () => {
    document.cookie = 'sp_appearance=dark; path=/';
    expect(readDeviceRecordRaw()).toBe('dark');
    expect(readDeviceRecord()).toEqual({ v: 1, mode: 'dark', lastClassic: 'dark' });
  });

  it('drops a malformed record: it can never turn Liquid Glass on', () => {
    localStorage.setItem('sp-appearance', '{"v":1,"mode":"Liquid Glass"}');
    expect(readDeviceRecord()).toBeNull();
    localStorage.setItem('sp-appearance', 'not json {');
    expect(readDeviceRecord()).toBeNull();
  });

  it('reads next-themes’ own stored theme for the legacy migration', () => {
    expect(readLegacyTheme()).toBeNull();
    localStorage.setItem('theme', 'dark');
    expect(readLegacyTheme()).toBe('dark');
  });
});

describe('the account sync record', () => {
  it('is written and removed, and sign-out removes it and tells the provider', () => {
    writeSyncRecord({ v: 1, userId: 'user-a', dirty: true, syncedAt: null });
    expect(JSON.parse(readSyncRecordRaw() as string)).toMatchObject({
      userId: 'user-a',
      dirty: true,
    });
    const heard = vi.fn();
    window.addEventListener(APPEARANCE_SIGNED_OUT_EVENT, heard);
    forgetAppearanceAccount();
    window.removeEventListener(APPEARANCE_SIGNED_OUT_EVENT, heard);
    expect(readSyncRecordRaw()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('the one-time crash fallback', () => {
  it('is noted only when glass is on screen, and keeps the stored choice', () => {
    writeDeviceRecord({ v: 1, mode: 'liquid-glass', lastClassic: 'system' });
    expect(noteGlassCrash()).toBe(false);
    expect(isCrashFallbackActive()).toBe(false);

    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    expect(noteGlassCrash()).toBe(true);
    expect(readCrashFallback()).toBe('pending');
    markCrashFallbackShown();
    expect(readCrashFallback()).toBe('shown');
    expect(noteGlassCrash()).toBe(true);
    expect(readCrashFallback()).toBe('shown');
    expect(readDeviceRecord()?.mode).toBe('liquid-glass');
  });

  it('Use classic appearance returns to the last classic choice through the one shared implementation', () => {
    writeDeviceRecord({ v: 1, mode: 'liquid-glass', lastClassic: 'light' });
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    expect(chooseClassicFromRecovery()).toBe('light');
    expect(readDeviceRecord()).toEqual({ v: 1, mode: 'light', lastClassic: 'light' });
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
  });
});
