/**
 * The landing brand lockup.
 *
 * PROTECTED GEOMETRY. `IntroMark` in components/marketing/landing-intro/mark.tsx
 * is a byte-identical copy of this glyph, because the loading intro's exit is a
 * shared-element handoff that flies its own mark into this one. Any difference —
 * a different `rx`, a different stroke width, a moved pip — pops visibly at the
 * crossfade. If this changes, change `mark.tsx` in the same commit.
 *
 * Specifically pinned: viewBox 0 0 100 100 · rect x/y 12, w/h 76, rx 16 · the S
 * carved as a mask knockout (never a foreground stroke) at strokeWidth 9 ·
 * pip circle cx 72 cy 24 r 6 in mint. `Pulse` in landing-intro.tsx is anchored
 * to markSize*0.72 / markSize*0.24 — the pip's own coordinates — so moving the
 * pip silently detaches the intro's confirmation pulse.
 *
 * The glyph is also sized by CSS to exactly 26px (`#sp-landing .glyph`), which
 * `LI.NAV_MARK_PX` hard-codes as the flight's target scale. Resizing it here
 * makes the intro's mark land at the wrong size, and no test catches that.
 */

/** Distinct mask ids per variant — two glyphs on one page would otherwise collide. */
export function BrandGlyph({ ink }: { ink?: boolean }) {
  const id = ink ? 'sp-fm' : 'sp-nm';
  return (
    <svg className="glyph" viewBox="0 0 100 100" aria-hidden>
      <mask id={id}>
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
        fill={ink ? 'currentColor' : '#faf9f4'}
        mask={`url(#${id})`}
      />
      <circle cx="72" cy="24" r="6" fill="#5db89f" />
    </svg>
  );
}

/**
 * The wordmark. Rendered as a SEPARATE SIBLING of the glyph, and the glyph comes
 * FIRST in the DOM — the intro measures `#sp-nav .brand`'s bounding rect and
 * aligns LEFT EDGES (`tx = rect.left - lockLeft`, with `transform-origin: left
 * center`). Putting the wordmark before the glyph, or adding left padding inside
 * `.brand`, sends the flown mark to the wrong x.
 */
export function Wordmark() {
  return (
    <span className="wordmark">
      <b>Stock</b>
      <span>Pilot</span>
    </span>
  );
}
