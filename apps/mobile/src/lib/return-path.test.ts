// The installed expo-router's own rule for "open outside the app" (the check
// linkTo runs before any in-app navigation). Plain CommonJS with no native
// imports, so node can load it; it grounds these tests in the real library.
import { shouldLinkExternally } from 'expo-router/build/utils/url';
import { describe, expect, it, vi } from 'vitest';

import { goBackFromReturn, inAppReturnPath, type ReturnBackRouter } from './return-path';

/**
 * THE PHONE'S `?return=` BACK TARGET CHECK (docket T14).
 *
 * Settings, Support, the AI screen, the Books tab and every DataListScreen list
 * send Back to the screen's `?return=` value. That value comes from any link
 * (stockpilot://notifications?return=...), and expo-router's router.replace
 * hands a value with a scheme or a leading `//` to Linking.openURL instead of
 * navigating, so an unchecked value made the app's own Back open a website or
 * another app. The deep-link shapes below are the ones the two security
 * verifiers built against the installed router.
 */

/** Values the router would hand to the operating system as they stand. */
const OPENS_OUTSIDE_THE_APP = [
  'https://phish.example/signin',
  'https://x.example',
  'http://x.example',
  'HTTPS://x.example',
  '//x.example',
  '//phish.example',
  'tel:123',
  'tel:+15555550100',
  'sms:1',
  'sms:+15555550100',
  'mailto:a@example.com',
  'otherapp://x',
  'otherapp://do-something',
  'stockpilot://support',
  'geo:0,0',
  'maps:q=x',
  'itms-apps://x',
  'file:///private/x',
];

/** Encoded or disguised forms of those, and other values that are not an in-app path. */
const DISGUISED_OR_NOT_A_PATH = [
  '',
  ' https://x.example',
  ' /settings',
  '/settings ',
  'settings',
  './settings',
  '../settings',
  '.',
  '..',
  'javascript:alert(1)',
  'data:text/html,x',
  // Backslash: browsers read "/\host" as "//host", and the router must never see one.
  '/\\x.example',
  '/settings\\x',
  '\\\\x.example',
  // Percent-encoded slashes, backslashes and colons, once and twice.
  '/%2F%2Fphish.example',
  '/%2f%2fphish.example',
  '%2F%2Fphish.example',
  '/%5Cphish.example',
  '/%5cphish.example',
  'https%3A%2F%2Fphish.example',
  '/https%3A%2F%2Fphish.example',
  '/%252F%252Fphish.example',
  '/%25252F%25252Fphish.example',
  '/%255Cphish.example',
  // A scheme anywhere in the path.
  '/https://phish.example',
  '/x:y',
  // Control characters, raw and encoded (tab, newline, carriage return, NUL, DEL).
  '/\t/phish.example',
  '/\n/phish.example',
  '/\r/phish.example',
  '/settings\u0000',
  '/settings\u007F',
  '/%09/phish.example',
  '/%0A/phish.example',
  '/%0D/phish.example',
  '/settings%00',
  '/settings%7F',
  // Whitespace and non-ASCII look-alikes (no-break space, line separator,
  // fullwidth solidus, which some parsers fold into "/").
  '/ settings',
  '/settings ',
  '/／phish.example',
  '/%EF%BC%8Fphish.example',
  // Empty and dot segments, which URL parsing collapses into "//".
  '/..//phish.example',
  '/settings//phish.example',
  '/./settings',
  '/settings/..',
  '/%2E%2E//phish.example',
  // Malformed or overlong percent-encoding.
  '/settings%',
  '/%E0%A4%A',
  '/%C0%AFphish.example',
  // Too long to be a route the app writes.
  `/${'a'.repeat(600)}`,
];

/** In-app paths: what the app sends today, and route shapes a caller could send. */
const IN_APP = [
  '/settings',
  '/locations',
  '/notifications',
  '/',
  '/item/0f8c3f6e-1111-4222-8333-944455556666',
  '/order/0f8c3f6e-1111-4222-8333-944455556666?focus=returns',
  '/settings?tab=profile',
  '/reports/book-order-totals?from=2026-10-01&to=2026-10-25',
  '/locations?return=/settings',
];

describe('inAppReturnPath', () => {
  it('the installed router opens each of these outside the app, which is why they are refused', () => {
    for (const href of OPENS_OUTSIDE_THE_APP) {
      expect(shouldLinkExternally(href), href).toBe(true);
    }
  });

  it('refuses every value the router would open outside the app', () => {
    for (const href of OPENS_OUTSIDE_THE_APP) {
      expect(inAppReturnPath(href), href).toBeNull();
    }
  });

  it('refuses encoded and disguised forms, control characters and anything that is not an in-app path', () => {
    for (const href of DISGUISED_OR_NOT_A_PATH) {
      expect(inAppReturnPath(href), JSON.stringify(href)).toBeNull();
    }
  });

  it('refuses a value that is not one string (absent, repeated param, wrong type)', () => {
    for (const raw of [
      undefined,
      null,
      42,
      true,
      {},
      ['/settings'],
      ['/settings', 'https://x.example'],
    ]) {
      expect(inAppReturnPath(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('keeps an in-app path unchanged, and the router never opens one outside the app', () => {
    for (const href of IN_APP) {
      expect(inAppReturnPath(href), href).toBe(href);
      expect(shouldLinkExternally(href), href).toBe(false);
    }
  });

  it('keeps the two values the app sends today (Settings > Locations, Settings > Notifications)', () => {
    expect(inAppReturnPath('/settings')).toBe('/settings');
  });
});

function fakeRouter(canGoBack: boolean) {
  const router = {
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => canGoBack),
  };
  return router as typeof router & ReturnBackRouter;
}

describe('goBackFromReturn', () => {
  it('goes to an in-app return path', () => {
    const router = fakeRouter(true);
    goBackFromReturn(router, '/settings');
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/settings');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('a refused value falls back to the normal Back: back when there is a screen to go back to', () => {
    for (const href of [...OPENS_OUTSIDE_THE_APP, ...DISGUISED_OR_NOT_A_PATH]) {
      const router = fakeRouter(true);
      goBackFromReturn(router, href);
      expect(router.back, JSON.stringify(href)).toHaveBeenCalledOnce();
      expect(router.replace, JSON.stringify(href)).not.toHaveBeenCalled();
    }
  });

  it('a refused value with nothing to go back to goes Home, never to the value', () => {
    for (const href of [...OPENS_OUTSIDE_THE_APP, ...DISGUISED_OR_NOT_A_PATH]) {
      const router = fakeRouter(false);
      goBackFromReturn(router, href);
      expect(router.replace, JSON.stringify(href)).toHaveBeenCalledExactlyOnceWith('/');
      expect(router.back, JSON.stringify(href)).not.toHaveBeenCalled();
    }
  });

  it('no return value: back, else Home (unchanged)', () => {
    const withStack = fakeRouter(true);
    goBackFromReturn(withStack, undefined);
    expect(withStack.back).toHaveBeenCalledOnce();
    expect(withStack.replace).not.toHaveBeenCalled();

    const alone = fakeRouter(false);
    goBackFromReturn(alone, undefined);
    expect(alone.replace).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('a repeated return param (an array) is refused, not followed', () => {
    const router = fakeRouter(true);
    goBackFromReturn(router, ['/settings', 'https://phish.example']);
    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
