'use client';

import * as React from 'react';

interface BigChartProps {
  data: Array<{ value: number; label?: string }>;
  height?: number;
  className?: string;
}

/**
 * Quiet editorial line/area chart used on the dashboard overview.
 * No external chart lib — just SVG + simple gridlines.
 */
export function BigChart({ data, height = 240, className }: BigChartProps) {
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

  if (data.length < 2) return null;

  const padX = 16;
  const padY = 18;
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (width - padX * 2) / (data.length - 1);
  const usableH = height - padY * 2;

  const pts = data.map((d, i) => [
    padX + i * stepX,
    padY + usableH - ((d.value - min) / span) * usableH,
  ] as const);

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area =
    `M${first[0].toFixed(1)},${height - padY} ` +
    pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
    ` L${last[0].toFixed(1)},${height - padY} Z`;

  return (
    <svg
      ref={ref}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
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
      <path d={area} fill="hsl(var(--accent))" opacity={0.1} />
      <path
        d={path}
        fill="none"
        stroke="hsl(var(--accent))"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={4} fill="hsl(var(--card))" stroke="hsl(var(--accent))" strokeWidth={1.6} />
    </svg>
  );
}

// MiniBarChart lives in its own file (mini-bar-chart.tsx). Importing it
// from there directly keeps it a Server Component instead of being
// dragged into this 'use client' module's client bundle.
