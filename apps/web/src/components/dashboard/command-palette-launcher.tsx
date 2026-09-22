'use client';

import * as React from 'react';

import type { CommandPaletteProps } from '@/components/dashboard/command-palette';

type PaletteComponent = React.ComponentType<CommandPaletteProps>;

/**
 * Fetches the palette's code (cmdk, its dialog, the result rows). A separate
 * chunk: every dashboard page used to download and parse it before it could
 * hydrate, although nobody sees the palette until they press ⌘K.
 */
export function loadCommandPalette(): Promise<PaletteComponent> {
  return import('@/components/dashboard/command-palette').then((m) => m.CommandPalette);
}

/**
 * The browser is idle after the page has hydrated: fetch the palette then, so
 * the first ⌘K almost always finds it already here. The timeout caps the wait
 * on a page that never goes idle (a busy realtime feed).
 */
const IDLE_TIMEOUT_MS = 4000;
/** Safari has no requestIdleCallback. */
const IDLE_FALLBACK_MS = 2000;

/**
 * ⌘K / Ctrl+K, except from a real text field: someone typing into a form is
 * never hijacked. The palette's own input carries data-cmdk="true", so ⌘K
 * there still closes it.
 */
function isPaletteChord(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return false;
  const active = document.activeElement as HTMLElement | null;
  const tag = (active?.tagName ?? '').toLowerCase();
  if ((tag === 'input' || tag === 'textarea') && active?.dataset.cmdk !== 'true') return false;
  return true;
}

/**
 * Owns the ⌘K listener and the open state, and loads the palette on the first
 * press or when the browser goes idle, whichever comes first.
 *
 * The first press is never lost: it flips `open` straight away, and the palette
 * mounts already open when its code lands. The topbar's search button
 * synthesizes the same ⌘K event, so it takes the same path.
 *
 * A plain import() rather than next/dynamic: inside app/, next/dynamic is
 * React.lazy under Suspense (next/dist/shared/lib/lazy-dynamic/loadable.js),
 * and React.lazy keeps a failed load and throws it into the nearest error
 * boundary, which here is (dashboard)/error.tsx (confirmed with a rejecting
 * loader under a test boundary). With the idle prefetch, one dropped chunk
 * request (a flaky connection, an old tab after a deploy) would replace the
 * page the person is reading, without them touching anything. Here a failed
 * load is caught, closes the palette, and the next press tries again.
 *
 * The state lives in this component, not in DashboardShell, so opening the
 * palette re-renders the palette alone, never the sidebar and topbar.
 */
export function CommandPaletteLauncher({
  load = loadCommandPalette,
}: {
  /** Test seam; production always uses loadCommandPalette. */
  load?: () => Promise<PaletteComponent>;
}) {
  const [open, setOpen] = React.useState(false);
  const [Palette, setPalette] = React.useState<PaletteComponent | null>(null);
  // Set while a load is in flight or done; cleared by a failure so the next
  // press retries. A ref, so a press and the idle callback in the same tick
  // cannot start two loads.
  const requestedRef = React.useRef(false);

  const ensureLoaded = React.useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    load().then(
      (component) => setPalette(() => component),
      (err: unknown) => {
        requestedRef.current = false;
        setOpen(false);
        console.warn('[command-palette] could not load; the next ⌘K retries', err);
      },
    );
  }, [load]);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!isPaletteChord(e)) return;
      e.preventDefault();
      ensureLoaded();
      setOpen((o) => !o);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ensureLoaded]);

  React.useEffect(() => {
    // Typed as always present by lib.dom; Safari does not ship it.
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => ensureLoaded(), { timeout: IDLE_TIMEOUT_MS });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(() => ensureLoaded(), IDLE_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [ensureLoaded]);

  if (!Palette) return null;
  return <Palette open={open} onOpenChange={setOpen} />;
}
