import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BigChart } from './big-chart';

/**
 * BigChart is a pure presentational SVG chart. Under happy-dom the ResizeObserver
 * polyfill never reports a width, so the component keeps its 720px default — every
 * y-coordinate below depends only on `height` + values (width only shifts x), so
 * the shared-scale assertions are stable regardless of layout.
 */

/** The series line <path>s (fill="none"); the area fill has a real fill. */
function linePaths(container: HTMLElement): SVGPathElement[] {
  return Array.from(container.querySelectorAll('path')).filter(
    (p) => p.getAttribute('fill') === 'none',
  ) as SVGPathElement[];
}

/** Parse an SVG line `d` ("M16.0,182.0 L704.0,18.0") into numeric points. */
function pointsOf(d: string): Array<{ x: number; y: number }> {
  return d
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [x, y] = tok.replace(/^[ML]/, '').split(',').map(Number);
      return { x: x!, y: y! };
    });
}

describe('BigChart — single-series back-compat', () => {
  it('renders exactly one line path plus an area fill for the `data` prop', () => {
    const { container } = render(
      <BigChart data={[{ value: 10 }, { value: 20 }, { value: 15 }]} height={200} />,
    );

    const lines = linePaths(container);
    expect(lines).toHaveLength(1);
    // Three points → three path commands.
    expect(pointsOf(lines[0]!.getAttribute('d')!)).toHaveLength(3);

    // Area fill present in single-series mode (the accent band under the line).
    const area = Array.from(container.querySelectorAll('path')).find(
      (p) => p.getAttribute('fill') === 'hsl(var(--accent))',
    );
    expect(area).toBeTruthy();

    // No legend in single-series mode.
    expect(container.querySelector('ul')).toBeNull();
  });

  it('maps values to the same y-coords the historical formula produced', () => {
    // height=200 → padY=18, usableH=164. min=0,max=100,span=100.
    const { container } = render(
      <BigChart data={[{ value: 0 }, { value: 50 }, { value: 100 }]} height={200} />,
    );
    const pts = pointsOf(linePaths(container)[0]!.getAttribute('d')!);
    // yFor(0)=182, yFor(50)=100, yFor(100)=18.
    expect(pts.map((p) => p.y)).toEqual([182, 100, 18]);
  });

  it('returns nothing when given fewer than 2 points', () => {
    const { container } = render(<BigChart data={[{ value: 5 }]} height={200} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('BigChart — multi-series', () => {
  it('renders one path per series plus a legend listing every label', () => {
    const { container, getByText } = render(
      <BigChart
        height={200}
        series={[
          { label: 'Cost', data: [{ value: 0 }, { value: 100 }] },
          { label: 'Retail', data: [{ value: 50 }, { value: 100 }] },
        ]}
      />,
    );

    expect(linePaths(container)).toHaveLength(2);

    // Legend present with both labels.
    const legend = container.querySelector('ul');
    expect(legend).toBeTruthy();
    expect(getByText('Cost')).toBeInTheDocument();
    expect(getByText('Retail')).toBeInTheDocument();
    // One swatch per series.
    expect(legend!.querySelectorAll('li')).toHaveLength(2);

    // Multi-series drops the area fill for a clean overlay.
    const area = Array.from(container.querySelectorAll('path')).find(
      (p) => p.getAttribute('fill') === 'hsl(var(--accent))',
    );
    expect(area).toBeUndefined();
  });

  it('shares ONE y-scale across all series (not per-series min/max)', () => {
    // Global min=0 (series1), max=100 (both). Under a SHARED scale, series2's
    // first value 50 lands mid-axis (y=100). Under a per-series scale it would
    // be series2's own min → the bottom (y=182). Asserting y=100 proves shared.
    const { container } = render(
      <BigChart
        height={200}
        series={[
          { label: 'A', data: [{ value: 0 }, { value: 100 }] },
          { label: 'B', data: [{ value: 50 }, { value: 100 }] },
        ]}
      />,
    );
    const [a, b] = linePaths(container);
    const aPts = pointsOf(a!.getAttribute('d')!);
    const bPts = pointsOf(b!.getAttribute('d')!);

    // Series A: 0 → bottom (182), 100 → top (18).
    expect(aPts.map((p) => p.y)).toEqual([182, 18]);
    // Series B: 50 → shared-scale mid (100), 100 → top (18).
    expect(bPts.map((p) => p.y)).toEqual([100, 18]);
    // The shared max maps to the same y in both series, and shares x too.
    expect(aPts[1]).toEqual(bPts[1]);
  });

  it('first series uses the primary accent so its stroke matches single-series', () => {
    const { container } = render(
      <BigChart
        height={200}
        series={[
          { label: 'A', data: [{ value: 1 }, { value: 2 }] },
          { label: 'B', data: [{ value: 3 }, { value: 4 }] },
        ]}
      />,
    );
    const [a, b] = linePaths(container);
    expect(a!.getAttribute('stroke')).toBe('hsl(var(--accent))');
    // Second series gets a distinct palette color.
    expect(b!.getAttribute('stroke')).not.toBe('hsl(var(--accent))');
  });

  it('honors an explicit per-series color override', () => {
    const { container } = render(
      <BigChart
        height={200}
        series={[
          { label: 'A', color: 'rebeccapurple', data: [{ value: 1 }, { value: 2 }] },
          { label: 'B', data: [{ value: 3 }, { value: 4 }] },
        ]}
      />,
    );
    expect(linePaths(container)[0]!.getAttribute('stroke')).toBe('rebeccapurple');
  });
});

describe('BigChart — guards', () => {
  it('renders nothing for an empty series array (and no `data`)', () => {
    const { container } = render(<BigChart series={[]} height={200} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('skips a series with fewer than 2 points instead of throwing', () => {
    const { container } = render(
      <BigChart
        height={200}
        series={[
          { label: 'Sparse', data: [{ value: 42 }] },
          { label: 'Full', data: [{ value: 1 }, { value: 2 }, { value: 3 }] },
        ]}
      />,
    );
    // Only the 3-point series draws; the 1-point one is skipped → single line,
    // so no legend (a single drawable series is not "multi").
    expect(linePaths(container)).toHaveLength(1);
    expect(container.querySelector('ul')).toBeNull();
  });

  it('renders series of differing lengths without throwing', () => {
    const { container } = render(
      <BigChart
        height={200}
        series={[
          { label: 'Short', data: [{ value: 1 }, { value: 2 }, { value: 3 }] },
          { label: 'Long', data: [{ value: 5 }, { value: 6 }, { value: 7 }, { value: 8 }, { value: 9 }] },
        ]}
      />,
    );
    const lines = linePaths(container);
    expect(lines).toHaveLength(2);
    // Short series keeps its own point count (3), long keeps 5 — aligned by index.
    expect(pointsOf(lines[0]!.getAttribute('d')!)).toHaveLength(3);
    expect(pointsOf(lines[1]!.getAttribute('d')!)).toHaveLength(5);
  });

  it('returns nothing when the only series is too short', () => {
    const { container } = render(
      <BigChart series={[{ label: 'Solo', data: [{ value: 9 }] }]} height={200} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});
