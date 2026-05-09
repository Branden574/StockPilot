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

    // Resolve the link element we'll update; create one if absent.
    let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"][data-animated="1"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.dataset.animated = '1';
      document.head.appendChild(link);
    }

    // Path is the same S the SVG draws: an open zigzag from upper-
    // right to lower-left. Coordinates scaled from 100x100 to SIZE.
    const scale = SIZE / 100;
    const drawFrame = (progress: number) => {
      // progress: 0 = empty, 0.5 = fully drawn, 1 = fully erased
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const fill = dark ? '#f6f4ef' : '#0c0c0e';
      const ink = dark ? '#0c0c0e' : '#f6f4ef';

      ctx.clearRect(0, 0, SIZE, SIZE);

      // Rounded-square frame
      const r = 10 * scale;
      const x = 6 * scale;
      const y = 6 * scale;
      const w = 52 * scale;
      const h = 52 * scale;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();

      // S-stroke path. We draw the path with destination-out so it
      // CARVES the frame instead of stamping ink — matches the SVG
      // mask approach.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 7 * scale;

      // Total path length (approx via dasharray in the SVG): 230 in
      // 100-unit space → scale.
      const totalLen = 230 * scale;
      // First half: draw forward. Second half: erase forward.
      // CSS keyframes: 0% offset=230, 45% offset=0, 80% offset=0,
      // 100% offset=-230.
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
      ctx.moveTo(20 * scale, 50 * scale);
      ctx.quadraticCurveTo(46 * scale, 50 * scale, 46 * scale, 42 * scale);
      ctx.quadraticCurveTo(46 * scale, 34 * scale, 34 * scale, 34 * scale);
      ctx.quadraticCurveTo(20 * scale, 34 * scale, 20 * scale, 26 * scale);
      ctx.quadraticCurveTo(20 * scale, 14 * scale, 46 * scale, 14 * scale);
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.restore();

      // Pip dot at the upper-right terminal — fades in mid-cycle
      const pipAlpha =
        progress < 0.42 ? 0 : progress < 0.5 ? (progress - 0.42) / 0.08 :
        progress < 0.78 ? 1 : progress < 0.88 ? 1 - (progress - 0.78) / 0.1 : 0;
      if (pipAlpha > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = pipAlpha;
        ctx.beginPath();
        ctx.arc(46 * scale, 14 * scale, 4 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      link!.href = canvas.toDataURL('image/png');
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
