'use client';

import * as React from 'react';

/**
 * Scroll reveals for the sections BELOW the film.
 *
 * The film ends when the story does, and everything after it — lattice, coverage
 * index, comparison, posture, close — was rendering completely static. Half the
 * page felt dead the moment the scrub stopped. These reveals carry the sense of
 * motion through to the end without pretending the film is still running.
 *
 * WHAT REVEALS, AND WHY IT TEACHES SOMETHING:
 *  - lattice cells ripple outward from the hero cell → breadth accumulating
 *  - stage columns and index columns run left to right → the path of goods,
 *    dock to shelf to audit, which is their actual reading order
 *  - comparison rows arrive top to bottom → the argument building row by row
 * Nothing loops, nothing repeats, and every element is unobserved once shown.
 *
 * NO-JS SAFETY. The hidden state is applied by the `reveal-armed` class that
 * THIS component adds at runtime. With JavaScript off the class never lands, so
 * every element renders at full opacity — the page is complete without motion,
 * which is what the E2E suite asserts. Never move the hidden state into a plain
 * `[data-reveal]` rule; that would blank half the page for crawlers.
 *
 * REDUCED MOTION is handled here rather than only in CSS: everything is marked
 * shown immediately and no observer is created at all.
 */
export function Reveal({ rootId }: { rootId: string }) {
  React.useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;

    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (targets.length === 0) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      for (const el of targets) el.classList.add('is-in');
      return;
    }

    // Arm only now — before this point the page has no hidden state at all.
    root.classList.add('reveal-armed');

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
    );

    for (const el of targets) io.observe(el);

    return () => {
      io.disconnect();
      root.classList.remove('reveal-armed');
    };
  }, [rootId]);

  return null;
}
