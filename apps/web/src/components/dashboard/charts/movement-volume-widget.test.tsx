import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MovementVolumeWidget } from './movement-volume-widget';
import type { MovementBar } from './widget-data';

/**
 * The Analytics "Movement volume" bars: every movement type keeps its axis
 * label, angled so neighbouring labels never overprint each other (P3.1 review
 * fix). Recharts is replaced by stand-ins that record the props each part gets.
 */

const axisProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const containerProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    BarChart: Pass,
    Bar: () => null,
    CartesianGrid: () => null,
    YAxis: () => null,
    XAxis: (props: Record<string, unknown>) => {
      axisProps.push(props);
      return null;
    },
  };
});

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({
    children,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode }) => {
    containerProps.push(props);
    return <div data-testid="chart">{children}</div>;
  },
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

beforeEach(() => {
  axisProps.length = 0;
  containerProps.length = 0;
});

const bars: MovementBar[] = [
  { type: 'remove', label: 'Remove', count: 12 },
  { type: 'bundle_assembly', label: 'Bundle Assembly', count: 9 },
  { type: 'adjust', label: 'Adjust', count: 7 },
  { type: 'bundle_distribution', label: 'Bundle Distribution', count: 4 },
  { type: 'return', label: 'Return', count: 2 },
];

describe('MovementVolumeWidget', () => {
  it('keeps every type label on the axis and angles them so they never overprint', () => {
    render(<MovementVolumeWidget bars={bars} />);
    expect(axisProps).toHaveLength(1);
    const x = axisProps[0]!;
    expect(x.dataKey).toBe('label');
    expect(x.interval).toBe(0);
    expect(x.angle).toBe(-35);
    expect(x.textAnchor).toBe('end');
    expect(x.height).toBe(96);
    expect(x.tick).toEqual({ fontSize: 11 });
  });

  it('grows the default chart by the axis height so the plot keeps its size', () => {
    render(<MovementVolumeWidget bars={bars} />);
    expect(containerProps[0]!.chartHeight).toBe(304);
    expect(containerProps[0]!.style).toEqual({ height: 304 });
  });

  it('honours a height the caller passes', () => {
    render(<MovementVolumeWidget bars={bars} height={320} />);
    expect(containerProps[0]!.chartHeight).toBe(320);
  });

  it('keeps the empty words when there were no movements', () => {
    render(<MovementVolumeWidget bars={[]} />);
    expect(screen.getByText('No movements in the last 30 days.')).toBeInTheDocument();
    expect(axisProps).toHaveLength(0);
  });
});
