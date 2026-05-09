'use client';

import * as React from 'react';

/**
 * Cross-browser animated favicon for the Mark D · Stencil Frame mark.
 *
 * Why this exists: SVG `<style>@keyframes` favicons (apps/web/src/app/icon.svg)
 * animate in Firefox but render as a static frame in Chromium-based
 * browsers (Chrome, Brave, Edge, Arc) and Safari. There's no spec
 * support for animated SVG favicons in those engines.
 *
 * Workaround: redraw the same mark to a tiny canvas every ~80ms,
 * convert to a data URL, and swap `<link rel="icon">` to the new
 * URL. Browsers happily accept the URL change and repaint the tab
 * icon. Cheap (32x32 canvas, simple path), tab-throttled by the
 * browser when the tab is backgrounded.
 *
 * Reduced-motion users: respect `prefers-reduced-motion`. We render
 * a single static frame and stop the loop.
 *
 * The static SVG favicon stays in place as the SSR/no-JS fallback
 * (Firefox + Safari users still see motion via the SVG keyframes
 * before this component mounts; Chromium users get static SVG
 * during the brief window before this component overrides).
 */
export function AnimatedFavicon() {
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const SIZE = 64; // 32x32 retina @2x — sharp on high-DPI displays
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Take ownership of the favicon. Next.js's app/icon.svg file
    // convention auto-injects `<link rel="icon" href="/icon?...">`,
    // plus there may be a manifest-supplied icon link. Browsers
    // usually render the first match they see, so appending our own
    // link without removing the others is invisible.
    //
    // Strip every existing `link[rel*=icon]` EXCEPT apple-touch-icon
    // (iOS home-screen still wants the static PNG). Then create a
    // single controlled link we'll update every frame.
    document
      .querySelectorAll<HTMLLinkElement>('link[rel*="icon" i]')
      .forEach((el) => {
        const rel = el.getAttribute('rel')?.toLowerCase() ?? '';
        if (rel.includes('apple-touch-icon')) return;
        el.parentNode?.removeChild(el);
      });
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.dataset.animated = '1';
    document.head.appendChild(link);

    // Coordinates mirror apps/web/src/app/icon.svg (viewBox 0 0 100 100):
    //   Frame:  x=12 y=12 w=76 h=76 rx=16
    //   S-path: M 32 78  Q 72 78 72 66  Q 72 54 54 54  Q 32 54 32 42  Q 32 24 72 24
    //           (stroke-width 11, total length ≈ 230 units)
    //   Pip:    cx=72 cy=24 r=6
    // Scale every literal by SIZE/100 so the layout is identical.
    const s = SIZE / 100;
    const drawFrame = (progress: number) => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const fill = dark ? '#f6f4ef' : '#0c0c0e';

      ctx.clearRect(0, 0, SIZE, SIZE);

      // Step 1: rounded-square frame, fully filled.
      const fx = 12 * s;
      const fy = 12 * s;
      const fw = 76 * s;
      const fh = 76 * s;
      const fr = 16 * s;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(fx + fr, fy);
      ctx.lineTo(fx + fw - fr, fy);
      ctx.quadraticCurveTo(fx + fw, fy, fx + fw, fy + fr);
      ctx.lineTo(fx + fw, fy + fh - fr);
      ctx.quadraticCurveTo(fx + fw, fy + fh, fx + fw - fr, fy + fh);
      ctx.lineTo(fx + fr, fy + fh);
      ctx.quadraticCurveTo(fx, fy + fh, fx, fy + fh - fr);
      ctx.lineTo(fx, fy + fr);
      ctx.quadraticCurveTo(fx, fy, fx + fr, fy);
      ctx.closePath();
      ctx.fill();

      // Step 2: CARVE the S out of the frame (destination-out matches
      // the SVG's mask=url(#m) trick — the carved path becomes the
      // negative space, and the frame fill shows through where the
      // carve isn't yet drawn).
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 11 * s;

      const totalLen = 230 * s;
      // Three-phase animation matching the SVG @keyframes:
      //   0%–45%: stroke draws in (offset 230 → 0)
      //   45%–80%: held drawn (offset 0)
      //   80%–100%: stroke erases (offset 0 → -230)
      let offset: number;
      if (progress < 0.45) {
        offset = totalLen - (progress / 0.45) * totalLen;
      } else if (progress < 0.8) {
        offset = 0;
      } else {
        offset = -((progress - 0.8) / 0.2) * totalLen;
      }
      ctx.setLineDash([totalLen, totalLen]);
      ctx.lineDashOffset = offset;

      ctx.beginPath();
      ctx.moveTo(32 * s, 78 * s);
      ctx.quadraticCurveTo(72 * s, 78 * s, 72 * s, 66 * s);
      ctx.quadraticCurveTo(72 * s, 54 * s, 54 * s, 54 * s);
      ctx.quadraticCurveTo(32 * s, 54 * s, 32 * s, 42 * s);
      ctx.quadraticCurveTo(32 * s, 24 * s, 72 * s, 24 * s);
      ctx.stroke();
      ctx.restore();

      // Step 3: pip dot at the upper-right terminal — fades in mid-
      // cycle as the stroke nears that endpoint.
      const pipAlpha =
        progress < 0.42 ? 0
        : progress < 0.5 ? (progress - 0.42) / 0.08
        : progress < 0.78 ? 1
        : progress < 0.88 ? 1 - (progress - 0.78) / 0.1
        : 0;
      if (pipAlpha > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = pipAlpha;
        ctx.beginPath();
        ctx.arc(72 * s, 24 * s, 6 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      link.href = canvas.toDataURL('image/png');
    };

    if (reduce) {
      // One static frame, fully drawn, no loop.
      drawFrame(0.6);
      return;
    }

    let raf = 0;
    let lastSwap = 0;
    const PERIOD = 3600; // ms — matches the SVG's animation-duration
    const start = performance.now();
    const loop = (now: number) => {
      // Throttle DOM writes to ~12fps — the favicon is tiny and
      // browsers don't redraw it faster than that anyway.
      if (now - lastSwap > 80) {
        const t = ((now - start) % PERIOD) / PERIOD;
        drawFrame(t);
        lastSwap = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Stop animating when the tab is hidden (most browsers throttle
    // already, but be explicit).
    const onVis = () => {
      if (document.hidden && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!document.hidden && !raf) {
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
