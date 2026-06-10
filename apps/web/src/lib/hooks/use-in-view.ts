'use client';

/* eslint-disable react-hooks/set-state-in-effect --
   An IntersectionObserver / matchMedia hook can only learn visibility + the
   reduced-motion preference at runtime (window is undefined during SSR), so it
   MUST set state from inside the effect. That's the canonical pattern; the rule
   is a false positive here. */
import * as React from 'react';

/**
 * Reveal-on-scroll primitive — a dependency-free IntersectionObserver wrapper
 * for the marketing page's scroll-triggered entrances (feature grid, stat band,
 * final CTA). Pairs with the `.reveal-up` CSS in globals.css.
 *
 * Honors prefers-reduced-motion: returns inView=true immediately so content is
 * shown at rest (no entrance) instead of animating.
 */
export function useInView<T extends HTMLElement>(opts?: {
  threshold?: number;
  rootMargin?: string;
  /** Reveal once and stop observing (default true). */
  once?: boolean;
}): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = React.useRef<T | null>(null);
  const [inView, setInView] = React.useState(false);
  const once = opts?.once ?? true;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { threshold: opts?.threshold ?? 0.15, rootMargin: opts?.rootMargin ?? '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once, opts?.threshold, opts?.rootMargin]);

  return { ref, inView };
}
