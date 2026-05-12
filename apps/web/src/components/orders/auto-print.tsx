'use client';

import { useEffect } from 'react';

/**
 * Fires the browser print dialog once the print page has loaded. Waits
 * for fonts + images so the rendered preview matches the printed output
 * (org logo, anything else loaded async). One-shot — re-mounts won't
 * re-trigger because the route only ever mounts this component once.
 */
export function AutoPrint() {
  useEffect(() => {
    let cancelled = false;

    async function fire() {
      try {
        if (typeof document !== 'undefined' && document.fonts?.ready) {
          await document.fonts.ready;
        }
      } catch {
        // Font readiness is a hint, not a hard requirement.
      }

      // Wait a frame after font/image readiness so layout settles before
      // the print engine takes its snapshot — avoids the "logo missing"
      // and "blank first page" artifacts on Safari + Brave.
      requestAnimationFrame(() => {
        if (cancelled) return;
        window.print();
      });
    }

    if (document.readyState === 'complete') {
      void fire();
    } else {
      const onLoad = () => void fire();
      window.addEventListener('load', onLoad, { once: true });
      return () => {
        cancelled = true;
        window.removeEventListener('load', onLoad);
      };
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
