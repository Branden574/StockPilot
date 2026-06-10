'use client';

import * as React from 'react';

/**
 * Subtle scroll-driven "settle" for the hero product mockup: the frame sits
 * tilted slightly back when it first appears and flattens as it scrolls toward
 * center. rAF-throttled, writes transform directly (off the React tree), and
 * disabled under prefers-reduced-motion. Pure polish — purely visual.
 */
export function HeroFrameParallax({ children }: { children: React.ReactNode }) {
  const innerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let ticking = false;
    const tick = () => {
      const rect = inner.getBoundingClientRect();
      // 0 when the frame is well below the fold → 1 once it's scrolled up past
      // center. Flatten the tilt + lift as it approaches the viewport center.
      const p = Math.min(
        Math.max((window.innerHeight - rect.top) / (window.innerHeight + rect.height * 0.5), 0),
        1,
      );
      const tilt = (1 - p) * 5; // deg
      const lift = (1 - p) * 6; // px
      inner.style.transform = `rotateX(${tilt.toFixed(2)}deg) translate3d(0, ${lift.toFixed(1)}px, 0)`;
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
  }, []);

  return (
    <div style={{ perspective: '1400px' }}>
      <div ref={innerRef} style={{ transformOrigin: 'center top', willChange: 'transform' }}>
        {children}
      </div>
    </div>
  );
}
