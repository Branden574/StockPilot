'use client';

import * as React from 'react';

/**
 * Shared scroll-progress hook for pinned scrollytelling sections.
 *
 * Wires a single rAF-throttled scroll + resize listener that writes a
 * normalized progress (0..1) into the `--p` CSS custom property of the
 * element returned by `stageRef`. Progress is `(scroll passed into
 * track) / (track height - viewport height)`, so the value smoothly
 * runs 0 → 1 across the entire pin.
 *
 * Both ScrollyWarehouse and ScrollyShelfScan had this same hook inlined
 * before. Sharing keeps the dependency-free pattern (no GSAP/Lenis)
 * while ensuring there's a single source of truth for any future
 * tuning (e.g. IntersectionObserver gating to pause when off-screen).
 *
 * Honors prefers-reduced-motion: pins to a resting-state value
 * (default 0.55, mid-scene) so the static composition still reads
 * meaningfully instead of starting at progress 0.
 */
export function useScrollyProgress({
  trackRef,
  stageRef,
  reducedMotionValue = 0.55,
}: {
  trackRef: React.RefObject<HTMLElement | null>;
  stageRef: React.RefObject<HTMLElement | null>;
  reducedMotionValue?: number;
}) {
  React.useEffect(() => {
    const track = trackRef.current;
    const stage = stageRef.current;
    if (!track || !stage) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      stage.style.setProperty('--p', reducedMotionValue.toString());
      return;
    }

    let ticking = false;
    const tick = () => {
      const rect = track.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      const passed = Math.min(Math.max(-rect.top, 0), total);
      const p = total > 0 ? passed / total : 0;
      stage.style.setProperty('--p', p.toFixed(4));
      ticking = false;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(tick);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [trackRef, stageRef, reducedMotionValue]);
}
