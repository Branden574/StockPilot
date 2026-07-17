'use client';

import * as React from 'react';

interface ChartPoint {
  value: number;
  label?: string;
}

interface ChartSeries {
  label: string;
  color?: string;
  data: ChartPoint[];
}

interface BigChartProps {
  /** Single-series convenience. Ignored when a non-empty `series` is given. */
  data?: ChartPoint[];
  /**
   * Multi-series overlay. When non-empty it takes precedence over `data`; every
   * series is drawn as its own line sharing ONE x/y scale so comparison lines
   * sit on the same axis. A series with fewer than 2 points is skipped (never
   * throws), so unequal / short / empty series are safe.
   */
  series?: ChartSeries[];
  height?: number;
  className?: string;
}

/**
 * Default series colors. Index 0 is the primary accent — identical to the
 * historical single-series chart — then the editorial chart palette (each hue
 * defined for light AND dark in globals.css). Wraps if there are more series
 * than colors. `--chart-1` (mint) is skipped to avoid two near-accent lines.
 */
const SERIES_PALETTE = [
  'hsl(var(--accent))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
] as const;

/**
 * Quiet editorial line/area chart used on the dashboard overview.
 * No external chart lib — just SVG + simple gridlines.
 */
export function BigChart({ data, series, height = 240, className }: BigChartProps) {
  const ref = React.useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = React.useState(720);

  React.useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // `series` (when non-empty) wins; otherwise fall back to the single `data`
  // line so existing single-series callers behave exactly as before.
  const resolved: ChartSeries[] =
    series && series.length > 0 ? series : data ? [{ label: '', data }] : [];

  // A line needs >= 2 points; shorter/empty series are skipped, not thrown.
  const drawable = resolved
    .map((s, i) => ({
      label: s.label,
      color: s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]!,
      data: s.data,
    }))
    .filter((s) => s.data.length >= 2);

  if (drawable.length === 0) return null;

  // Shared y-scale across EVERY series' values (including any skipped short
  // series) so overlaid lines are comparable on one axis.
  const allValues = resolved.flatMap((s) => s.data.map((d) => d.value)).filter((v) => Number.isFinite(v));
  if (allValues.length === 0) return null;

  const multi = drawable.length > 1;
  const padX = 16;
  const padY = 18;
  const usableH = height - padY * 2;

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = max - min || 1;

  // Shared x-scale by index: stepX spans the LONGEST series so equal-length
  // series line up point-for-point; a shorter series simply ends early.
  const maxLen = Math.max(...drawable.map((s) => s.data.length));
  const stepX = (width - padX * 2) / (maxLen - 1);

  const xFor = (i: number) => padX + i * stepX;
  const yFor = (v: number) => padY + usableH - ((v - min) / span) * usableH;

  const lines = drawable.map((s) => {
    const pts = s.data.map((d, i) => [xFor(i), yFor(d.value)] as const);
    const path = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
      .join(' ');
    return { label: s.label, color: s.color, pts, path, last: pts[pts.length - 1]! };
  });

  // Area fill only in single-series mode — a filled band under one of several
  // overlaid lines would muddy the comparison, so multi-series stays lines-only.
  const primary = lines[0]!;
  const area = multi
    ? null
    : `M${primary.pts[0]![0].toFixed(1)},${height - padY} ` +
      primary.pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
      ` L${primary.pts[primary.pts.length - 1]![0].toFixed(1)},${height - padY} Z`;

  const svg = (
    <svg
      ref={ref}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={multi ? undefined : className}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const y = padY + (i * usableH) / 4;
        return (
          <line
            key={i}
            x1={padX}
            x2={width - padX}
            y1={y}
            y2={y}
            stroke="hsl(var(--border))"
            strokeDasharray="2 4"
          />
        );
      })}
      {area ? <path d={area} fill="hsl(var(--accent))" opacity={0.1} /> : null}
      {lines.map((s, i) => (
        <path
          key={`line-${i}`}
          d={s.path}
          fill="none"
          stroke={s.color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {lines.map((s, i) => (
        <circle
          key={`dot-${i}`}
          cx={s.last[0]}
          cy={s.last[1]}
          r={4}
          fill="hsl(var(--card))"
          stroke={s.color}
          strokeWidth={1.6}
        />
      ))}
    </svg>
  );

  // Legend only in multi-series mode — compact swatch + label row.
  if (!multi) return svg;

  return (
    <div className={className}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-5 pt-1 font-mono text-[11px] text-[var(--ed-ink-3)]">
        {lines.map((s, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ backgroundColor: s.color }}
            />
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
      {svg}
    </div>
  );
}

// MiniBarChart lives in its own file (mini-bar-chart.tsx). Importing it
// from there directly keeps it a Server Component instead of being
// dragged into this 'use client' module's client bundle.
