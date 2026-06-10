const WORDS = [
  'Receive',
  'Transfer',
  'Cycle count',
  'Reorder',
  'Pick',
  'Pack',
  'Deliver',
  'Reconcile',
  'Audit',
  'Sync',
  'Forecast',
  'Restock',
];

/**
 * Connective tissue between the pinned chapters and the proof/feature sections.
 * A seamless CSS-only marquee (the track is doubled and translated -50%), so it
 * needs no JS and stays a server component. Pauses under reduced-motion + on
 * hover. Decorative → aria-hidden.
 */
export function MarqueeStrip() {
  const row = (
    <div className="flex shrink-0 items-center">
      {WORDS.map((w) => (
        <span key={w} className="flex items-center">
          <span className="px-6 font-display text-[clamp(20px,3vw,34px)] font-medium tracking-[-0.02em] text-[var(--ed-ink-3)]">
            {w}
          </span>
          <span className="h-1 w-1 shrink-0 rounded-full bg-[#ff7a45]" />
        </span>
      ))}
    </div>
  );

  return (
    <section aria-hidden className="overflow-hidden border-y border-border py-6">
      <div className="marquee-track flex w-max">
        {row}
        {row}
      </div>
      <style>{`
        .marquee-track { animation: sp-marquee 38s linear infinite; }
        .marquee-track:hover { animation-play-state: paused; }
        @keyframes sp-marquee {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(-50%, 0, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .marquee-track { animation: none; }
        }
      `}</style>
    </section>
  );
}
