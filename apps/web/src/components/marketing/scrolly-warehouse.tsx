'use client';

import * as React from 'react';

/**
 * Pinned scrollytelling section — inspired by madarplatform.com's
 * wireframe-truck pin, retooled for StockPilot. A wireframe warehouse
 * translates across a sticky viewport-sized stage as the user scrolls
 * through the pin's parent (~3.5 viewport-heights tall). Three feature
 * labels reveal at fixed progress milestones, mapped to warehouse parts
 * (racks → items, loading bay → movements, office → POs). Floating
 * metric chips slide in alongside.
 *
 * No GSAP / Lenis dep — single scroll listener throttled to
 * requestAnimationFrame writes a normalized progress (0..1) into a CSS
 * custom property on the stage. Every animated element interpolates
 * off `--p` via CSS calc(), which keeps style updates off the React
 * tree entirely and the section silent during scroll on slow devices.
 *
 * Honors prefers-reduced-motion: skips the pin entirely and renders
 * one resting-state composition.
 */
export function ScrollyWarehouse() {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const track = trackRef.current;
    const stage = stageRef.current;
    if (!track || !stage) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      stage.style.setProperty('--p', '0.55');
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
  }, []);

  return (
    <section
      ref={trackRef}
      aria-label="A walk through the warehouse"
      className="scrolly-track relative"
      style={{ height: '350vh' }}
    >
      <div
        ref={stageRef}
        className="scrolly-stage sticky top-0 flex h-screen w-full items-center justify-center overflow-hidden"
        style={
          {
            // p is updated on scroll. CSS reads this for every animation.
            ['--p' as string]: '0',
          } as React.CSSProperties
        }
      >
        <FloorStreaks />
        <Warehouse />
        <FeatureLabels />
        <MetricChips />
        <ChapterTitle />
        <ScrollHint />
      </div>

      {/* Scoped animation rules. All transitions are linear in CSS — */}
      {/* the easing curve lives in the scroll-mapping (cubic interpolation */}
      {/* via calc + clamp) rather than transition timing, which keeps */}
      {/* every element perfectly in sync with finger position. */}
      <style>{`
        .scrolly-stage {
          background:
            radial-gradient(1200px 600px at 70% 60%, rgba(70,194,202,0.08), transparent 70%),
            radial-gradient(900px 500px at 30% 45%, rgba(255,122,69,0.08), transparent 70%);
        }
        .scrolly-warehouse {
          /* Vehicle slides from far right (translateX 35%) to far left (-65%) */
          /* over the full scroll. Slight scale-down as it "passes" the camera. */
          transform: translate3d(
            calc((0.35 - var(--p) * 1.0) * 100%),
            0,
            0
          ) scale(calc(1 - var(--p) * 0.12));
          opacity: clamp(0, calc((1 - var(--p)) * 1.3), 1);
          will-change: transform, opacity;
        }
        .scrolly-streak {
          opacity: clamp(0, calc(var(--p) * 1.4 + 0.15), 1);
          transform: translate3d(calc(var(--p) * -8%), 0, 0);
        }
        .scrolly-label {
          opacity: 0;
          transform: translate3d(0, 12px, 0);
          transition: none;
        }
        /* Three labels reveal at progress 0.18 / 0.40 / 0.62 (when the */
        /* corresponding warehouse part is centered in the viewport) and */
        /* fade together near the end of the pin so they don't crowd the */
        /* exit. Each label keeps its own reveal threshold; the shared */
        /* fade-out term clamps everything to 0 as p approaches 1. */
        .scrolly-label-1 { opacity: clamp(0, min(calc((var(--p) - 0.12) * 8), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(0, calc(max(0px, (0.18 - var(--p)) * 80px)), 0); }
        .scrolly-label-2 { opacity: clamp(0, min(calc((var(--p) - 0.34) * 8), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(0, calc(max(0px, (0.40 - var(--p)) * 80px)), 0); }
        .scrolly-label-3 { opacity: clamp(0, min(calc((var(--p) - 0.56) * 8), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(0, calc(max(0px, (0.62 - var(--p)) * 80px)), 0); }
        .scrolly-chip-1 { opacity: clamp(0, min(calc((var(--p) - 0.08) * 8), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.14 - var(--p)) * 60px)), 0, 0); }
        .scrolly-chip-2 { opacity: clamp(0, min(calc((var(--p) - 0.28) * 8), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.34 - var(--p)) * 60px)), 0, 0); }
        .scrolly-chip-3 { opacity: clamp(0, min(calc((var(--p) - 0.48) * 8), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.54 - var(--p)) * 60px)), 0, 0); }
        .scrolly-chapter-title {
          opacity: clamp(0, calc(var(--p) * 6), 1);
          transform: translate3d(0, calc(max(0px, (0.05 - var(--p)) * 60px)), 0);
        }
        .scrolly-hint {
          opacity: clamp(0, calc((0.08 - var(--p)) * 12), 1);
        }
        @media (prefers-reduced-motion: reduce) {
          .scrolly-warehouse,
          .scrolly-streak,
          .scrolly-label-1,
          .scrolly-label-2,
          .scrolly-label-3,
          .scrolly-chip-1,
          .scrolly-chip-2,
          .scrolly-chip-3,
          .scrolly-chapter-title,
          .scrolly-hint {
            transition: none !important;
          }
        }
      `}</style>
    </section>
  );
}

function ChapterTitle() {
  return (
    <div className="scrolly-chapter-title pointer-events-none absolute right-6 top-[12vh] z-30 max-w-[420px] text-right sm:right-12">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--ed-ink-4)]">
        — A walk through the warehouse
      </p>
      <h2 className="mt-2 font-display text-[clamp(34px,4.5vw,56px)] font-medium leading-[0.98] tracking-[-0.03em] text-balance">
        Three things <span className="font-serif-italic text-[var(--ed-ink-3)]">live</span>
        <br />
        in the same room.
      </h2>
    </div>
  );
}

function ScrollHint() {
  return (
    <div className="scrolly-hint pointer-events-none absolute bottom-8 left-1/2 z-30 -translate-x-1/2 text-center">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--ed-ink-4)]">
        Scroll
      </div>
      <div className="mx-auto mt-1.5 h-6 w-px bg-[var(--ed-ink-4)]" />
    </div>
  );
}

function FloorStreaks() {
  return (
    <svg
      className="scrolly-streak pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[60%] w-full"
      viewBox="0 0 1600 540"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="streakOrange" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff7a45" stopOpacity="0" />
          <stop offset="0.4" stopColor="#ff7a45" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff7a45" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="streakTeal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#46c2ca" stopOpacity="0" />
          <stop offset="0.5" stopColor="#46c2ca" stopOpacity="0.5" />
          <stop offset="1" stopColor="#46c2ca" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="streakAmber" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f5b042" stopOpacity="0" />
          <stop offset="0.5" stopColor="#f5b042" stopOpacity="0.42" />
          <stop offset="1" stopColor="#f5b042" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Vanishing-point perspective: streaks converge upper-right */}
      <g strokeLinecap="round" fill="none">
        <path d="M -50 540 Q 600 360 1650 220" stroke="url(#streakOrange)" strokeWidth="2.5" />
        <path d="M -50 510 Q 700 340 1650 200" stroke="url(#streakAmber)" strokeWidth="2" />
        <path d="M -50 470 Q 800 320 1650 180" stroke="url(#streakTeal)" strokeWidth="2.2" />
        <path d="M -50 430 Q 900 300 1650 160" stroke="url(#streakOrange)" strokeWidth="1.6" opacity="0.7" />
        <path d="M -50 390 Q 950 270 1650 140" stroke="url(#streakTeal)" strokeWidth="1.4" opacity="0.6" />
      </g>
    </svg>
  );
}

/**
 * Hand-authored wireframe warehouse in side profile. Three visible
 * zones map to the three feature labels:
 *   1. Right ⅓ — rack/shelving stacks (Items)
 *   2. Middle — loading dock with rolling door (Movements)
 *   3. Left ⅓ — small office wing (Purchase orders)
 *
 * Stroke-only, no fills. Drawn at 1400×440 viewBox; scales via the
 * width attr in the parent.
 */
function Warehouse() {
  // Strokes inherit from the SVG's `color` (set via text-foreground on the
  // wrapper) so the wireframe is visible in both light and dark themes.
  // "dim" lines render inside a group with reduced opacity rather than a
  // hardcoded rgba — that way they too inherit the theme color.
  const stroke = 'currentColor';
  return (
    <div className="scrolly-warehouse pointer-events-none absolute inset-x-0 top-[28vh] z-10 flex justify-center text-foreground">
      <svg
        viewBox="0 0 1400 440"
        className="h-auto w-[min(1300px,95vw)]"
        fill="none"
        aria-hidden
      >
        {/* Ground line — extends past warehouse to suggest dock floor */}
        <line x1="0" y1="390" x2="1400" y2="390" stroke="currentColor" opacity="0.32" strokeWidth="1.2" />
        <line x1="0" y1="395" x2="1400" y2="395" stroke="currentColor" opacity="0.32" strokeWidth="0.6" />

        {/* ===== Office wing (left) ===== */}
        <g stroke={stroke} strokeWidth="1.6" strokeLinejoin="round">
          <rect x="80" y="220" width="220" height="170" />
          {/* Pitched roof on office */}
          <polyline points="80,220 190,170 300,220" />
          {/* Door */}
          <rect x="118" y="300" width="44" height="90" />
          <circle cx="153" cy="345" r="2" fill={stroke} />
          {/* Windows */}
          <rect x="180" y="245" width="40" height="32" />
          <rect x="232" y="245" width="40" height="32" />
          <line x1="200" y1="245" x2="200" y2="277" />
          <line x1="180" y1="261" x2="220" y2="261" />
          <line x1="252" y1="245" x2="252" y2="277" />
          <line x1="232" y1="261" x2="272" y2="261" />
          {/* Small chimney/vent */}
          <rect x="220" y="180" width="14" height="22" />
        </g>

        {/* ===== Main warehouse body (loading bay + racks) ===== */}
        <g stroke={stroke} strokeWidth="1.8" strokeLinejoin="round">
          {/* Main facade outline */}
          <rect x="300" y="120" width="1020" height="270" />
          {/* Pitched roof line — subtle, runs from front-top diagonally to back-top, suggesting depth */}
          <polyline points="300,120 350,80 1370,80 1320,120" />
          <line x1="1370" y1="80" x2="1370" y2="350" stroke="currentColor" opacity="0.32" strokeWidth="1.2" />
          <line x1="1320" y1="390" x2="1370" y2="350" stroke="currentColor" opacity="0.32" strokeWidth="1.2" />
          {/* Roof ridge marks */}
          <line x1="350" y1="80" x2="1370" y2="80" />
          {/* Top fascia band */}
          <line x1="300" y1="150" x2="1320" y2="150" />
        </g>

        {/* ===== Loading dock — large rolling door ===== */}
        <g stroke={stroke} strokeWidth="1.6" strokeLinejoin="round">
          <rect x="350" y="200" width="200" height="190" />
          {/* Rolled-down panels */}
          {[225, 250, 275, 300, 325, 350, 375].map((y) => (
            <line key={y} x1="358" y1={y} x2="542" y2={y} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
          ))}
          {/* Dock concrete ledge */}
          <line x1="345" y1="390" x2="555" y2="390" strokeWidth="2.2" />
          {/* Bumper pads */}
          <rect x="360" y="378" width="20" height="12" />
          <rect x="520" y="378" width="20" height="12" />
          {/* "LOADING BAY" tiny placard */}
          <rect x="395" y="172" width="110" height="20" />
          <text x="450" y="186" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" letterSpacing="2" fill={stroke}>BAY 1</text>
        </g>

        {/* Second smaller dock */}
        <g stroke={stroke} strokeWidth="1.4" strokeLinejoin="round">
          <rect x="580" y="240" width="120" height="150" />
          {[262, 282, 302, 322, 342, 362, 382].map((y) => (
            <line key={y} x1="586" y1={y} x2="694" y2={y} stroke="currentColor" opacity="0.32" strokeWidth="0.8" />
          ))}
          <rect x="610" y="218" width="60" height="16" />
        </g>

        {/* ===== Rack zone (right side, visible "through" facade lines) ===== */}
        <g stroke={stroke} strokeWidth="1.3" strokeLinejoin="round">
          {/* Three rack stacks, each three shelves tall */}
          {[
            { x: 740, w: 160 },
            { x: 920, w: 160 },
            { x: 1100, w: 200 },
          ].map((r) => (
            <g key={r.x}>
              {/* Outer rack frame */}
              <rect x={r.x} y={170} width={r.w} height={220} />
              {/* Shelves */}
              <line x1={r.x} y1={225} x2={r.x + r.w} y2={225} />
              <line x1={r.x} y1={280} x2={r.x + r.w} y2={280} />
              <line x1={r.x} y1={335} x2={r.x + r.w} y2={335} />
              {/* Uprights at quarter divisions — suggest pallet bays */}
              <line x1={r.x + r.w / 3} y1={170} x2={r.x + r.w / 3} y2={390} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
              <line x1={r.x + (2 * r.w) / 3} y1={170} x2={r.x + (2 * r.w) / 3} y2={390} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
              {/* Pallet boxes scattered across shelves */}
              <rect x={r.x + 12} y={232} width={26} height={20} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
              <rect x={r.x + 48} y={232} width={26} height={20} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
              <rect x={r.x + r.w - 60} y={290} width={26} height={20} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
              <rect x={r.x + r.w / 2 - 14} y={345} width={28} height={20} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
              <rect x={r.x + 16} y={345} width={28} height={20} stroke="currentColor" opacity="0.32" strokeWidth="0.9" />
            </g>
          ))}
        </g>

        {/* Anchor markers at the three label-attachment points */}
        <g fill={stroke}>
          <circle cx="990" cy="240" r="3" data-anchor="items" />
          <circle cx="450" cy="290" r="3" data-anchor="movements" />
          <circle cx="190" cy="280" r="3" data-anchor="orders" />
        </g>
      </svg>
    </div>
  );
}

function FeatureLabels() {
  // Anchored visually to the corresponding warehouse zone via absolute
  // positioning. Percentages match the SVG anchor points above.
  return (
    <>
      <LabelLine
        className="scrolly-label scrolly-label-1"
        // Items — racks zone (right of warehouse)
        style={{ top: '34vh', left: '64%' }}
        title="Items that mean something"
        body="Not just SKUs. Origins, lots, par levels, costs — all first-class. Cycle counts that survive an audit."
      />
      <LabelLine
        className="scrolly-label scrolly-label-2"
        // Movements — loading bay zone (middle)
        style={{ top: '52vh', left: '28%' }}
        title="Movements you can trust"
        body="Receive, sell, transfer, adjust. Every quantity change is a row you can stand behind."
      />
      <LabelLine
        className="scrolly-label scrolly-label-3"
        // Purchase orders — office wing (left)
        style={{ top: '36vh', left: '8%' }}
        title="Purchase orders, end to end"
        body="Draft → approve → in transit → received. Three-way match against your receiving counts."
      />
    </>
  );
}

function LabelLine({
  className,
  style,
  title,
  body,
}: {
  className: string;
  style: React.CSSProperties;
  title: string;
  body: string;
}) {
  return (
    <div
      className={`${className} pointer-events-none absolute z-20 max-w-[260px]`}
      style={style}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[#ff7a45]" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ed-ink-4)]">
          Anchored
        </span>
      </div>
      <h3 className="font-display text-[19px] font-medium leading-[1.15] tracking-[-0.01em]">
        {title}
      </h3>
      <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[var(--ed-ink-3)]">{body}</p>
    </div>
  );
}

function MetricChips() {
  return (
    <>
      <Chip
        className="scrolly-chip-1"
        style={{ top: '15vh', left: '6vw' }}
        label="ON HAND"
        value="248 SKUs"
        accent="#46c2ca"
      />
      <Chip
        className="scrolly-chip-2"
        style={{ top: '24vh', left: '4vw' }}
        label="TODAY"
        value="47 movements"
        accent="#ff7a45"
      />
      <Chip
        className="scrolly-chip-3"
        style={{ top: '72vh', left: '6vw' }}
        label="LOW STOCK"
        value="3 items · 1 critical"
        accent="#f5b042"
      />
    </>
  );
}

function Chip({
  className,
  style,
  label,
  value,
  accent,
}: {
  className: string;
  style: React.CSSProperties;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div
      className={`${className} pointer-events-none absolute z-20 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 backdrop-blur-sm`}
      style={style}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
      <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--ed-ink-4)]">
        {label}
      </span>
      <span className="font-mono text-[11.5px] tabular-nums">{value}</span>
    </div>
  );
}
