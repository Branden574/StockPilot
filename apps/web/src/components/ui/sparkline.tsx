import { memo } from 'react';

import { cn } from '@/lib/utils';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  /**
   * Visual treatment. `auto` infers up/down from the first vs last point.
   */
  tone?: 'up' | 'down' | 'flat' | 'auto';
}

// memo'd: this component rebuilds its SVG path (toFixed per point) on every
// render. In a large list (e.g. the 50-row inventory table) an unrelated state
// change — toggling a row checkbox — would otherwise recompute every visible
// sparkline. With a referentially-stable `data` array the shallow-prop compare
// lets each sparkline skip the work. See InventoryTable's `seriesByItem` memo.
export const Sparkline = memo(function Sparkline({
  data,
  width = 60,
  height = 18,
  className,
  tone = 'auto',
}: SparklineProps) {
  if (data.length < 2) return <span className={className} style={{ display: 'inline-block', width, height }} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;

  const stepX = width / (data.length - 1);
  const padY = 2;
  const usableH = height - padY * 2;

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = padY + usableH - ((v - min) / span) * usableH;
    return [x, y] as const;
  });

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const lastPoint = points[points.length - 1]!;
  const firstPoint = points[0]!;
  const area = `M${firstPoint[0]},${height} ${path.slice(1)} L${lastPoint[0].toFixed(1)},${height} Z`;

  const inferred: 'up' | 'down' | 'flat' =
    tone === 'auto'
      ? data[data.length - 1]! > data[0]!
        ? 'up'
        : data[data.length - 1]! < data[0]!
          ? 'down'
          : 'flat'
      : tone;

  const lineColor =
    inferred === 'up' ? 'hsl(var(--accent))' : inferred === 'down' ? 'hsl(var(--destructive))' : 'var(--ed-ink-3)';
  const areaColor =
    inferred === 'up' ? 'hsl(var(--accent) / 0.14)' : inferred === 'down' ? 'hsl(var(--destructive) / 0.10)' : 'transparent';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('inline-block align-middle', className)}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={area} fill={areaColor} />
      <path d={path} fill="none" stroke={lineColor} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
