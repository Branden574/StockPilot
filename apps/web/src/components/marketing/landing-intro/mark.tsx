/**
 * The intro's brand mark.
 *
 * This is the LANDING NAV's glyph geometry, not the design package's "Mark D".
 * The two are different shapes (rx 16 vs 18, mask-knockout vs stroke-draw,
 * different S path, different pip colour), and the intro's whole exit is a
 * shared-element handoff into that nav glyph — flying a different shape into it
 * pops visibly at the crossfade. Owner chose the seamless handoff, so the mark
 * here is kept byte-identical to BrandGlyph in scrolly-landing.tsx. If that
 * glyph ever changes, change this with it.
 *
 * The S and the pip are carved negative space via the mask; never draw them as
 * foreground strokes.
 */
export function IntroMark({ size, idSalt }: { size: number; idSalt: string }) {
  const maskId = `li-mark-${idSalt}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ display: 'block' }}
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
      <rect x="12" y="12" width="76" height="76" rx="16" fill="#faf9f4" mask={`url(#${maskId})`} />
      <circle cx="72" cy="24" r="6" fill="#5db89f" />
    </svg>
  );
}
