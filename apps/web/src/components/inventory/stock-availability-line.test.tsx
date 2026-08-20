import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockAvailabilityLine } from './stock-availability-line';

describe('StockAvailabilityLine', () => {
  it('renders nothing when nothing is reserved', () => {
    // "46 available · 0 reserved" under "46 on hand" is three ways of saying
    // one number. The line must earn its space.
    const { container } = render(<StockAvailabilityLine onHand={46} reserved={0} unit="unit" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows what a new order can actually take', () => {
    render(<StockAvailabilityLine onHand={100} reserved={72} unit="unit" />);
    expect(screen.getByText('28')).toBeInTheDocument();
    expect(screen.getByText(/72 reserved for open orders/)).toBeInTheDocument();
  });

  it('fully reserved shows 0 available and no alarm', () => {
    render(<StockAvailabilityLine onHand={40} reserved={40} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText(/short of what is promised/)).not.toBeInTheDocument();
  });

  it('OVER-reserved is called out, not left looking sold out', () => {
    // 12 promised against 10 owned clamps to "0 available", which is identical
    // on screen to plainly sold out. Sold out is normal; this is a promise
    // nobody can keep, so it gets its own words.
    render(<StockAvailabilityLine onHand={10} reserved={12} />);
    expect(screen.getByText(/2 short of what is promised/)).toBeInTheDocument();
  });

  it('does not signal severity with colour alone', () => {
    // Warehouse screens get read on cheap handsets in bad light.
    const { container } = render(<StockAvailabilityLine onHand={10} reserved={12} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByText(/short of what is promised/)).toBeInTheDocument();
  });
});
