/**
 * Content-readiness for the landing intro.
 *
 * "Ready" = hydration done AND fonts settled AND the hero's LCP image decoded.
 * Each signal is individually time-capped, so one slow signal can never hold the
 * exit past its own cap — and the caller still applies the global 1500ms hard
 * cap on top. There is deliberately no single uncontrolled setTimeout anywhere:
 * every wait is bounded and every listener is removable.
 *
 * The hero LCP element on this landing is the full-bleed poster <img
 * id="sp-poster"> (1920x1080), not the H1 — verified in the audit. Its decode is
 * the signal that actually correlates with "the page looks finished".
 */

/** Per-signal ceilings. Sum is irrelevant — they run concurrently. */
export const FONT_CAP_MS = 1200;
export const IMAGE_CAP_MS = 1200;

export const HERO_LCP_SELECTOR = '#sp-poster';

type Cleanup = () => void;

/** Resolve when `p` settles or `cap` ms elapse — whichever comes first. */
function withCap(p: Promise<unknown>, cap: number, registerCleanup: (c: Cleanup) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = window.setTimeout(finish, cap);
    registerCleanup(() => {
      window.clearTimeout(timer);
      finish();
    });
    p.then(finish, finish);
  });
}

/** Fonts settled, capped. Absent Font Loading API resolves immediately. */
function fontsReady(registerCleanup: (c: Cleanup) => void): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts || typeof fonts.ready?.then !== 'function') return Promise.resolve();
  return withCap(fonts.ready, FONT_CAP_MS, registerCleanup);
}

/** Hero image decoded (or already complete), capped. Missing image resolves now. */
function heroImageReady(registerCleanup: (c: Cleanup) => void): Promise<void> {
  const img = document.querySelector<HTMLImageElement>(HERO_LCP_SELECTOR);
  if (!img) return Promise.resolve();
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();

  const settled = new Promise<void>((resolve) => {
    // decode() rejects on a broken image; either way we stop waiting.
    if (typeof img.decode === 'function') {
      img.decode().then(
        () => resolve(),
        () => resolve(),
      );
      return;
    }
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    registerCleanup(() => {
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
    });
  });

  return withCap(settled, IMAGE_CAP_MS, registerCleanup);
}

export interface ReadinessHandle {
  /** Resolves once every capped signal has settled. */
  promise: Promise<void>;
  /** Abort all waits and listeners (component unmounted / failed safe). */
  cancel: Cleanup;
}

/**
 * Start watching. Hydration is implicit: this only runs from an effect, which
 * by definition means React has hydrated this subtree.
 */
export function watchReadiness(): ReadinessHandle {
  const cleanups: Cleanup[] = [];
  const register = (c: Cleanup) => cleanups.push(c);

  const promise = Promise.all([fontsReady(register), heroImageReady(register)]).then(() => undefined);

  return {
    promise,
    cancel: () => {
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          // never let cleanup throw during unmount
        }
      }
    },
  };
}
