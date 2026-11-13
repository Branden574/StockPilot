import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPEARANCE_SIGNED_OUT_EVENT,
  appearanceCookieString,
  chooseClassicFromRecovery,
  ensureStyleCookie,
  forgetAppearanceAccount,
  hiddenTwinSelector,
  isCrashFallbackActive,
  markCrashFallbackShown,
  markIntroSeen,
  noteGlassCrash,
  postStyleCookie,
  readAnonFlowRaw,
  readAppearanceCookie,
  readCrashFallback,
  readDeviceRecord,
  readDeviceRecordRaw,
  readIntroSeen,
  readLegacyTheme,
  readSyncRecordRaw,
  repairAppearanceCookie,
  SERVER_COOKIE_REFRESH_MS,
  STYLE_COOKIE_ROUTE,
  writeAnonFlow,
  writeDeviceRecord,
  writeSyncRecord,
} from './appearance-cookie';

/**
 * The web's appearance records (plans/REVISION-DEFAULT.md R2, R6; section 9
 * items 11 and 42): the `sp_style` cookie the head script paints from, the v2
 * device record, the sync record, this tab's signed-out stamp, the intro
 * notice, the crash fallback, and the durable cookie the server sets.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 3, 12);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.cookie = 'sp_appearance=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.documentElement.removeAttribute('data-appearance');
});

/** The route calls made, as { style } bodies. */
const routeCalls = () =>
  fetchMock.mock.calls.map(([url, init]) => {
    const request = init as RequestInit;
    return {
      url,
      method: request.method,
      header: new Headers(request.headers).get('x-sp-appearance'),
      body: JSON.parse(String(request.body)) as unknown,
    };
  });

/** Spy on document.cookie writes (the setter), keeping the real cookie jar. */
function spyCookieWrites(): string[] {
  const writes: string[] = [];
  let owner = Object.getPrototypeOf(document) as object | null;
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'cookie')) {
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  const real = Object.getOwnPropertyDescriptor(owner!, 'cookie')!;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => real.get!.call(document) as string,
    set: (value: string) => {
      writes.push(value);
      real.set!.call(document, value);
    },
  });
  return writes;
}
afterEach(() => {
  // Remove the instance override, if a test installed one.
  delete (document as unknown as Record<string, unknown>).cookie;
});

describe('the Design cookie', () => {
  it('holds only the Design, for 400 days, site-wide, lax, secure on https; never HttpOnly', () => {
    expect(appearanceCookieString('liquid-glass', true)).toBe(
      'sp_style=liquid-glass; path=/; max-age=34560000; samesite=lax; secure',
    );
    expect(appearanceCookieString('classic', false)).toBe(
      'sp_style=classic; path=/; max-age=34560000; samesite=lax',
    );
    expect(appearanceCookieString('classic', true)).not.toMatch(/httponly/iu);
  });

  it('reads the cookie by exact name; the stage 2 name is not read', () => {
    expect(readAppearanceCookie('a=1; sp_style=classic; b=2')).toBe('classic');
    expect(readAppearanceCookie('xsp_style=classic')).toBeNull();
    expect(readAppearanceCookie('sp_appearance=liquid-glass')).toBeNull();
    expect(readAppearanceCookie('')).toBeNull();
  });
});

describe('the device record', () => {
  it('writes v2 to localStorage and the explicit Design to the cookie, then asks the server to re-issue it', async () => {
    writeDeviceRecord({ v: 2, style: 'classic', theme: 'dark', anonAt: 5 });
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({
      v: 2,
      style: 'classic',
      theme: 'dark',
      anonAt: 5,
    });
    expect(readAppearanceCookie(document.cookie)).toBe('classic');
    expect(readDeviceRecord(NOW)).toEqual({ v: 2, style: 'classic', theme: 'dark', anonAt: 5 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(routeCalls()).toEqual([
      { url: STYLE_COOKIE_ROUTE, method: 'POST', header: '1', body: { style: 'classic' } },
    ]);
  });

  it('a Theme-only record writes no cookie and calls no route: a person who never chose a Design gets no cookie', () => {
    const writes = spyCookieWrites();
    writeDeviceRecord({ v: 2, theme: 'dark' });
    expect(writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not touch a cookie that already holds the Design (no write, no route call)', () => {
    document.cookie = 'sp_style=classic; path=/';
    const writes = spyCookieWrites();
    writeDeviceRecord({ v: 2, style: 'classic', theme: 'light' });
    expect(writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the cookie when localStorage holds nothing', () => {
    document.cookie = 'sp_style=classic; path=/';
    expect(readDeviceRecordRaw()).toEqual({ v: 2, style: 'classic' });
    expect(readDeviceRecord(NOW)).toEqual({ v: 2, style: 'classic' });
  });

  it('a malformed or stage 2 record means "never chose" (null): the rollout default applies', () => {
    localStorage.setItem('sp-appearance', '{"v":1,"mode":"liquid-glass","lastClassic":"dark"}');
    expect(readDeviceRecord(NOW)).toBeNull();
    localStorage.setItem('sp-appearance', '{"v":2,"style":"Classic"}');
    expect(readDeviceRecord(NOW)).toBeNull();
    localStorage.setItem('sp-appearance', 'not json {');
    expect(readDeviceRecord(NOW)).toBeNull();
    localStorage.removeItem('sp-appearance');
    document.cookie = 'sp_style=dark; path=/';
    expect(readDeviceRecordRaw()).toBeNull();
  });

  /**
   * localStorage that throws for the device record's key only, as a full
   * quota does. (A spy on Storage.prototype misses happy-dom's calls for a key
   * already stored, so the whole object is swapped.)
   */
  function failDeviceStorage(methods: ('setItem' | 'removeItem')[]) {
    const real = window.localStorage;
    const failing = (method: 'setItem' | 'removeItem') => methods.includes(method);
    const fake = {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === 'sp-appearance' && failing('setItem')) {
          throw new DOMException('full', 'QuotaExceededError');
        }
        real.setItem(key, value);
      },
      removeItem: (key: string) => {
        if (key === 'sp-appearance' && failing('removeItem')) {
          throw new DOMException('blocked', 'SecurityError');
        }
        real.removeItem(key);
      },
    } as unknown as Storage;
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(fake);
  }

  it('a localStorage write that fails drops the older record, so the next load reads the cookie that holds the choice', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    failDeviceStorage(['setItem']);
    writeDeviceRecord({ v: 2, style: 'classic' });
    expect(readAppearanceCookie(document.cookie)).toBe('classic');
    expect(readDeviceRecord(NOW)?.style).toBe('classic');
  });

  it('when the older record cannot be dropped either, the cookie keeps saying what the next load will read', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    document.cookie = 'sp_style=liquid-glass; path=/';
    failDeviceStorage(['setItem', 'removeItem']);
    writeDeviceRecord({ v: 2, style: 'classic' });
    expect(readAppearanceCookie(document.cookie)).toBe('liquid-glass');
    expect(readDeviceRecord(NOW)?.style).toBe('liquid-glass');
  });

  it('reads next-themes’ own stored theme (inherited, never uploaded)', () => {
    expect(readLegacyTheme()).toBeNull();
    localStorage.setItem('theme', 'dark');
    expect(readLegacyTheme()).toBe('dark');
  });
});

describe('cookie durability on load (R6, round 2 finding 1)', () => {
  it('a matching cookie is never written again on hydrate', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    const writes = spyCookieWrites();
    expect(repairAppearanceCookie()).toBe(false);
    expect(writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a missing cookie is written once and followed at once by one route call', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    const writes = spyCookieWrites();
    expect(repairAppearanceCookie()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^sp_style=classic; path=\/; max-age=34560000; samesite=lax/u);
    expect(routeCalls()).toEqual([
      { url: STYLE_COOKIE_ROUTE, method: 'POST', header: '1', body: { style: 'classic' } },
    ]);
  });

  it('a cookie that disagrees with the stored Design is repaired, then the route called once', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    document.cookie = 'sp_style=classic; path=/';
    const writes = spyCookieWrites();
    expect(repairAppearanceCookie()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(readAppearanceCookie(document.cookie)).toBe('liquid-glass');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a person who never chose a Design gets no cookie', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, theme: 'dark' }));
    const writes = spyCookieWrites();
    expect(repairAppearanceCookie()).toBe(false);
    expect(ensureStyleCookie(NOW)).toBe(false);
    expect(writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the server to re-issue the cookie at most once a day, and stamps only a 2xx answer', async () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    const writes = spyCookieWrites();

    // Never stamped: due.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(ensureStyleCookie(NOW)).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(localStorage.getItem('sp-style-server-at')).toBeNull();

    // The failed call left no stamp: retried on the next load.
    expect(ensureStyleCookie(NOW + 1000)).toBe(true);
    await vi.waitFor(() => expect(localStorage.getItem('sp-style-server-at')).not.toBeNull());

    // Stamped: not again within the day.
    const stamp = Number(localStorage.getItem('sp-style-server-at'));
    expect(ensureStyleCookie(stamp + SERVER_COOKIE_REFRESH_MS - 1)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A day later: again.
    expect(ensureStyleCookie(stamp + SERVER_COOKIE_REFRESH_MS)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The client never wrote the matching cookie in all of that.
    expect(writes).toEqual([]);
  });

  it('a hydrate that repairs the cookie makes exactly one route call (no second, daily one)', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    expect(ensureStyleCookie(NOW)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('postStyleCookie sends the header and the Design, same origin, and never throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(postStyleCookie('liquid-glass')).resolves.toBe(false);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers((init as RequestInit).headers).get('content-type')).toBe('application/json');
  });
});

describe('the account sync record and this tab’s signed-out stamp', () => {
  it('is written and removed, and sign-out removes it and tells the provider', () => {
    writeSyncRecord({ v: 2, userId: USER, dirtyAxes: ['style'], syncedAt: null });
    expect(JSON.parse(readSyncRecordRaw() as string)).toEqual({
      v: 2,
      userId: USER,
      dirtyAxes: ['style'],
      syncedAt: null,
    });
    const heard = vi.fn();
    window.addEventListener(APPEARANCE_SIGNED_OUT_EVENT, heard);
    forgetAppearanceAccount();
    window.removeEventListener(APPEARANCE_SIGNED_OUT_EVENT, heard);
    expect(readSyncRecordRaw()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keeps the signed-out stamp in sessionStorage, per tab', () => {
    expect(readAnonFlowRaw()).toBeNull();
    writeAnonFlow({ v: 1, anonAt: 5, axes: ['style'] });
    expect(JSON.parse(sessionStorage.getItem('sp-appearance-anon')!)).toEqual({
      v: 1,
      anonAt: 5,
      axes: ['style'],
    });
    expect(localStorage.getItem('sp-appearance-anon')).toBeNull();
    writeAnonFlow(null);
    expect(readAnonFlowRaw()).toBeNull();
  });
});

describe('the one-time intro notice', () => {
  it('is remembered on this device', () => {
    expect(readIntroSeen()).toBe(false);
    markIntroSeen();
    expect(readIntroSeen()).toBe(true);
    expect(localStorage.getItem('sp-lg-intro-seen')).not.toBeNull();
  });
});

describe('the one-time crash fallback', () => {
  it('is noted only when glass is on screen, and keeps the stored choice', () => {
    writeDeviceRecord({ v: 2, style: 'liquid-glass' });
    expect(noteGlassCrash()).toBe(false);
    expect(isCrashFallbackActive()).toBe(false);

    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    expect(noteGlassCrash()).toBe(true);
    expect(readCrashFallback()).toBe('pending');
    markCrashFallbackShown();
    expect(readCrashFallback()).toBe('shown');
    expect(noteGlassCrash()).toBe(true);
    expect(readCrashFallback()).toBe('shown');
    expect(readDeviceRecord(NOW)?.style).toBe('liquid-glass');
  });

  it('Use classic design sets the Design to Classic and keeps the Theme, through the one shared implementation', () => {
    writeDeviceRecord({ v: 2, style: 'liquid-glass', theme: 'dark' });
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    expect(chooseClassicFromRecovery()).toBeUndefined();
    expect(readDeviceRecord(NOW)).toEqual({ v: 2, style: 'classic', theme: 'dark' });
    expect(readAppearanceCookie(document.cookie)).toBe('classic');
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
  });
});

describe('the hidden appearance twin', () => {
  it('is the glass-only one in Classic and the classic-only one in glass (visibility.css)', () => {
    expect(hiddenTwinSelector(false)).toBe('[data-glass-only]');
    expect(hiddenTwinSelector(true)).toBe('[data-classic-only]');
  });
});
