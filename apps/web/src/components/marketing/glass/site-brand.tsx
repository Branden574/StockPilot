import Link from 'next/link';

/**
 * The StockPilot glyph and wordmark as SiteNav.dc.html and SiteFooter.dc.html
 * draw them: the rounded square with the S carved out as a mask and the mint
 * pip, beside "Stock" in the ink and "Pilot" softer. Each instance needs its
 * own mask id (two glyphs on one page would otherwise share one mask).
 * Glass marketing twins only (app/(site-glass)); classic pages keep IconMark.
 */
export function SiteGlyph({ maskId, className }: { maskId: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'lgs-glyph size-[26px] shrink-0'}
    >
      <mask id={maskId}>
        <rect width="100" height="100" fill="#fff" />
        <path
          d="M64 38 q0 -10 -14 -10 q-14 0 -14 11 q0 9 14 11 q14 2 14 11 q0 11 -14 11 q-14 0 -14 -10"
          fill="none"
          stroke="#000"
          strokeWidth="9"
          strokeLinecap="round"
        />
      </mask>
      <rect
        x="12"
        y="12"
        width="76"
        height="76"
        rx="16"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
      <circle cx="72" cy="24" r="6" fill="#5DB89F" />
    </svg>
  );
}

/** The brand link: home, named "StockPilot home" as the boards name it. */
export function SiteBrand({ maskId }: { maskId: string }) {
  return (
    <Link
      href="/"
      aria-label="StockPilot home"
      className="lgs-brand inline-flex items-center gap-[9px]"
    >
      <SiteGlyph maskId={maskId} />
      <span className="lgs-wordmark">
        Stock<span>Pilot</span>
      </span>
    </Link>
  );
}
