interface BarChartProps {
  values: number[];
  height?: number;
  className?: string;
}

/**
 * Quiet bar visualization for the dashboard's 30-day movement
 * tile. Pure SVG-ish (just flexbox + div backgrounds) — no hooks, no
 * client APIs — so it stays a Server Component and doesn't drag itself
 * into a client bundle the way BigChart does (which legitimately needs
 * ResizeObserver for fluid width).
 */
export function MiniBarChart({ values, height = 120, className }: BarChartProps) {
  const max = Math.max(...values, 1);
  return (
    <div
      className={className}
      style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height }}
      aria-hidden
    >
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${(v / max) * 100}%`,
            // One flat muted-ink fill (the redesign has no gradients); the
            // reference's charts draw in ink 3 when they are not the accent.
            background: 'var(--ed-ink-3)',
            opacity: 0.7,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}
