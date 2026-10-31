import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ResponsiveContainer measures its parent and draws nothing at 0 x 0, which
// is the size of every element in a test DOM. The tooltip content needs only
// the chart's config, which ChartContainer provides around it.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { setDefaultLocale } from '@/test/hydration';

import { ChartContainer, ChartTooltipContent } from './chart';

/**
 * B9: a tooltip without its own formatter printed `value.toLocaleString()`,
 * the BROWSER's locale, so the Movement volume tooltip read "1.234" in a
 * German browser while every count around it reads "1,234".
 */
function tooltipWith(value: number | string | ReadonlyArray<number | string>) {
  return render(
    <ChartContainer config={{ count: { label: 'Movements' } }}>
      <ChartTooltipContent
        active
        hideLabel
        payload={[{ name: 'count', dataKey: 'count', value, payload: {} }] as never}
      />
    </ChartContainer>,
  );
}

describe('ChartTooltipContent figures', () => {
  it('prints a number in the app format in a German browser', () => {
    const restore = setDefaultLocale('de-DE');
    try {
      tooltipWith(1234);
      expect(screen.getByText('1,234')).toBeInTheDocument();
      expect(screen.getByText('Movements')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('prints each end of a range in the app format, and a text value as it is', () => {
    const restore = setDefaultLocale('de-DE');
    try {
      const { unmount } = tooltipWith([1200, 3400.5]);
      expect(screen.getByText('1,200–3,400.5')).toBeInTheDocument();
      unmount();
      tooltipWith('n/a');
      expect(screen.getByText('n/a')).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});
