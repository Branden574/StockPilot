'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

/**
 * Global top progress bar that responds to every in-app navigation.
 * Covers links the sidebar's per-link NavLinkPending indicator can't
 * see — topbar, dashboard cards, table rows, breadcrumbs, action
 * buttons that call router.push.
 *
 * How it works:
 *   • Document-level capture-phase click listener on internal <a>
 *     links (same-origin, not modified-click). Fires the moment the
 *     user clicks, which is before Next.js's RSC fetch even starts.
 *   • Bar fills to ~80% on a fast ease curve, then pauses (mimics
 *     the classic NProgress feel — we don't actually know how long
 *     the RSC fetch will take, so the asymptotic crawl signals "still
 *     working" without lying about completion).
 *   • Completes when usePathname() reports a new path OR when 8s of
 *     guard time has elapsed without a path change (failsafe so a
 *     prevented/cancelled nav doesn't leave the bar stuck).
 *
 * Safe by construction:
 *   • Only ever triggers a CSS animation on a 2px-tall div. No data
 *     fetching, no router patching, no React state outside this
 *     component.
 *   • No effect on the actual navigation flow — pure visual feedback.
 *   • Failsafe timer makes it impossible for the bar to remain
 *     visible after a real navigation completes.
 */
export function NavProgressBar() {
  const pathname = usePathname();
  const [phase, setPhase] = React.useState<'idle' | 'climbing' | 'completing'>('idle');
  const startPathRef = React.useRef<string | null>(null);
  const failsafeRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    function isModifiedClick(e: MouseEvent): boolean {
      return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
    }

    function onClick(e: MouseEvent) {
      if (isModifiedClick(e)) return;
      let el = e.target as HTMLElement | null;
      // Walk up to the nearest <a> (clicks often land on an icon or
      // span inside the link).
      while (el && el.tagName !== 'A') el = el.parentElement;
      if (!el) return;
      const a = el as HTMLAnchorElement;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      const href = a.getAttribute('href');
      if (!href) return;
      // Only intercept same-origin app routes. Skip hash links + protocol links.
      if (href.startsWith('#') || /^[a-z]+:/i.test(href)) return;
      // Skip in-page nav to the same path (no progress bar needed).
      let nextPath: string;
      try {
        nextPath = new URL(a.href, window.location.origin).pathname;
      } catch {
        return;
      }
      if (nextPath === window.location.pathname) return;
      startPathRef.current = window.location.pathname;
      setPhase('climbing');
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
      failsafeRef.current = setTimeout(() => {
        // 8s no-completion guard: cancel quietly. Real navs that take
        // longer are unusual enough that we'd rather hide the bar than
        // pretend it's still loading.
        setPhase('idle');
      }, 8000);
    }

    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  React.useEffect(() => {
    if (phase === 'climbing' && startPathRef.current !== pathname) {
      // Navigation completed — pathname changed.
      setPhase('completing');
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
      const t = setTimeout(() => setPhase('idle'), 250);
      return () => clearTimeout(t);
    }
  }, [pathname, phase]);

  if (phase === 'idle') return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px]"
    >
      <div
        className={
          phase === 'climbing'
            ? 'h-full origin-left animate-[nav-progress-climb_2.8s_cubic-bezier(0.2,0.8,0.2,1)_forwards] bg-[hsl(var(--accent))] shadow-[0_0_8px_hsl(var(--accent))]'
            : 'h-full origin-left animate-[nav-progress-complete_240ms_ease-out_forwards] bg-[hsl(var(--accent))] shadow-[0_0_8px_hsl(var(--accent))]'
        }
      />
    </div>
  );
}
