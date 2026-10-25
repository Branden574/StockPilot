import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * A REAL server render followed by a REAL hydration, with the clock and the
 * time zone each side would have (and, when asked, each side's default
 * locale: ClockShift.browserLocale).
 *
 * Production (2026-10-05): React error #418 on /dashboard/movements and
 * /dashboard/returns/[id]. A client component renders on the server first
 * (Vercel: UTC, the server's clock) and again in the browser while it
 * hydrates (the viewer's zone and clock, a minute or more later). Text that
 * depends on either ("3 minutes ago", a toLocaleDateString()) can come out
 * different, and React then discards the server HTML. A plain render() never
 * hydrates, so it cannot see this; this helper does what the browser does.
 */
export interface ClockShift {
  /** The server's clock at its render (ms since the epoch). */
  serverNow: number;
  /** The browser's clock when it hydrates: later than the server, or behind it. */
  browserNow: number;
  /** The server's zone. Default UTC, as on Vercel. */
  serverZone?: string;
  /** The browser's zone. Default America/Los_Angeles, where every organization is today. */
  browserZone?: string;
  /**
   * The browser's language: the locale a formatter that names none uses while
   * it hydrates (see setDefaultLocale). Unset, neither side's default locale
   * is touched.
   */
  browserLocale?: string;
  /** The server's default locale, applied only with `browserLocale`. Default en-US, as on Vercel. */
  serverLocale?: string;
}

/**
 * Makes every number and date formatter that is given no locale use `locale`,
 * as a browser set to that language does, and returns the undo.
 *
 * A bare `n.toLocaleString()` (or `new Intl.NumberFormat()`) formats in the
 * runtime's default locale: en-US on the server, the viewer's language in
 * the browser. A client component that formats that way prints "1,234" on
 * the server and "1.234" while a German browser hydrates it, and React then
 * discards the server HTML (error #418). Node fixes its default locale when
 * it starts, so this stands in for the browser: Number and Date toLocale*
 * and the Intl.NumberFormat and Intl.DateTimeFormat constructors get
 * `locale` whenever the caller passes no locale (undefined or an empty
 * list). A call that names its locale is unchanged.
 */
export function setDefaultLocale(locale: string): () => void {
  const pick = (locales: Intl.LocalesArgument): Intl.LocalesArgument =>
    locales === undefined || (Array.isArray(locales) && locales.length === 0) ? locale : locales;
  const numberToLocaleString = Number.prototype.toLocaleString;
  const dateToLocaleString = Date.prototype.toLocaleString;
  const dateToLocaleDateString = Date.prototype.toLocaleDateString;
  const dateToLocaleTimeString = Date.prototype.toLocaleTimeString;
  const intl = Intl as {
    NumberFormat: typeof Intl.NumberFormat;
    DateTimeFormat: typeof Intl.DateTimeFormat;
  };
  const NumberFormat = intl.NumberFormat;
  const DateTimeFormat = intl.DateTimeFormat;

  Number.prototype.toLocaleString = function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return numberToLocaleString.call(this, pick(locales), options);
  };
  Date.prototype.toLocaleString = function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return dateToLocaleString.call(this, pick(locales), options);
  };
  Date.prototype.toLocaleDateString = function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return dateToLocaleDateString.call(this, pick(locales), options);
  };
  Date.prototype.toLocaleTimeString = function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return dateToLocaleTimeString.call(this, pick(locales), options);
  };
  // Called with or without `new`, as the built-ins may be.
  intl.NumberFormat = new Proxy(NumberFormat, {
    construct: (target, args: [Intl.LocalesArgument?, Intl.NumberFormatOptions?]) =>
      new target(pick(args[0]), args[1]),
    apply: (target, _this, args: [Intl.LocalesArgument?, Intl.NumberFormatOptions?]) =>
      target(pick(args[0]), args[1]),
  });
  intl.DateTimeFormat = new Proxy(DateTimeFormat, {
    construct: (target, args: [Intl.LocalesArgument?, Intl.DateTimeFormatOptions?]) =>
      new target(pick(args[0]), args[1]),
    apply: (target, _this, args: [Intl.LocalesArgument?, Intl.DateTimeFormatOptions?]) =>
      target(pick(args[0]), args[1]),
  });

  return () => {
    Number.prototype.toLocaleString = numberToLocaleString;
    Date.prototype.toLocaleString = dateToLocaleString;
    Date.prototype.toLocaleDateString = dateToLocaleDateString;
    Date.prototype.toLocaleTimeString = dateToLocaleTimeString;
    intl.NumberFormat = NumberFormat;
    intl.DateTimeFormat = DateTimeFormat;
  };
}

/** Runs `fn` with `locale` as the default locale (setDefaultLocale), then restores it. */
export function inLocale<T>(locale: string, fn: () => T): T {
  const restore = setDefaultLocale(locale);
  try {
    return fn();
  } finally {
    restore();
  }
}

export interface HydrationRun {
  /** The element the server HTML was hydrated into. */
  container: HTMLElement;
  /** The server render. */
  html: string;
  /** Every recoverable error React raised and everything it printed with console.error while hydrating. */
  errors: unknown[];
  unmount: () => void;
}

function setZone(zone: string | undefined) {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

/**
 * Runs `fn` with this process in `zone`, then restores the zone: what a
 * browser there would print, e.g. inZone(LA, () => new Date(at).toLocaleDateString()).
 */
export function inZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  setZone(zone);
  try {
    return fn();
  } finally {
    setZone(previous);
  }
}

/** The browser zone hydrateAcrossClockShift uses unless told otherwise. */
export const BROWSER_ZONE = 'America/Los_Angeles';

/**
 * Renders `render()` on the server side of `shift`, puts the HTML in the
 * document, then hydrates a fresh `render()` over it on the browser side, and
 * returns what React reported. The zone and fake clock are restored before
 * returning; text React printed after hydration stays in the DOM to assert on.
 */
export async function hydrateAcrossClockShift(
  render: () => ReactNode,
  shift: ClockShift,
): Promise<HydrationRun> {
  const previousZone = process.env.TZ;
  vi.useFakeTimers({ toFake: ['Date'] });
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
  // Each side's default locale, only when the caller names the browser's.
  const browserLocale = shift.browserLocale;
  try {
    setZone(shift.serverZone ?? 'UTC');
    vi.setSystemTime(shift.serverNow);
    const restoreServerLocale =
      browserLocale === undefined ? null : setDefaultLocale(shift.serverLocale ?? 'en-US');
    let html: string;
    try {
      html = renderToString(render());
    } finally {
      restoreServerLocale?.();
    }

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    setZone(shift.browserZone ?? BROWSER_ZONE);
    vi.setSystemTime(shift.browserNow);
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    // Effects and the post-hydration re-render run inside act(); tell React
    // this is a test so it flushes them without a warning.
    env.IS_REACT_ACT_ENVIRONMENT = true;
    let root: Root | undefined;
    const restoreBrowserLocale =
      browserLocale === undefined ? null : setDefaultLocale(browserLocale);
    try {
      await act(async () => {
        root = hydrateRoot(container, render(), {
          onRecoverableError: (error) => errors.push(error),
        });
      });
    } finally {
      restoreBrowserLocale?.();
      consoleError.mockRestore();
    }
    return {
      container,
      html,
      errors,
      unmount: () => {
        const before = env.IS_REACT_ACT_ENVIRONMENT;
        env.IS_REACT_ACT_ENVIRONMENT = true;
        try {
          act(() => root?.unmount());
        } finally {
          env.IS_REACT_ACT_ENVIRONMENT = before;
          container.remove();
        }
      },
    };
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    vi.useRealTimers();
    setZone(previousZone);
  }
}
