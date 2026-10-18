import { render, screen } from '@testing-library/react';
import { DollarSign } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { StatCard } from './stat-card';

/**
 * StatCard keeps its props and its consumers (Overview stat row, purchase
 * orders, warehouse detail); only its look follows the stat strip cell.
 */
describe('StatCard', () => {
  it('prints the label, the figure and the foot line as the page passes them', () => {
    render(<StatCard label="On the water" value={1} foot="PO-7 · ETA Oct 10" icon={DollarSign} />);
    expect(screen.getByText('On the water')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    // The PO list test reads the foot as one text node.
    expect(screen.getByText('PO-7 · ETA Oct 10')).toBeInTheDocument();
  });

  it('colours a rising delta in the accent (page text), a falling one destructive, flat muted', () => {
    const { rerender } = render(
      <StatCard label="Inventory value" value="$1" delta={{ value: '+4.2%', direction: 'up' }} />,
    );
    const delta = () => screen.getByText(/%|—/).closest('span')!;
    expect(delta()).toHaveClass('text-accent');
    expect(delta().className).not.toContain('accent-foreground');
    rerender(
      <StatCard label="Inventory value" value="$1" delta={{ value: '−3.0%', direction: 'down' }} />,
    );
    expect(delta()).toHaveClass('text-destructive');
    rerender(<StatCard label="Inventory value" value="$1" delta={{ value: '—' }} />);
    expect(delta()).toHaveClass('text-muted-foreground');
  });

  it('prints the label and its icon in ink 3, never the faint ink 4 (below AA for small text)', () => {
    const { container } = render(<StatCard label="Inventory value" value="$1" icon={DollarSign} />);
    const label = screen.getByText('Inventory value');
    expect(label).toHaveClass('text-muted-foreground');
    expect(container.innerHTML).not.toContain('--ed-ink-4');
  });

  it('draws the sparkline only for two or more points', () => {
    const { container, rerender } = render(<StatCard label="Items" value={3} series={[4]} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<StatCard label="Items" value={3} series={[4, 6, 5]} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('is a flat card: no shadow, radius 8, the figure in the display face at 24', () => {
    const { container } = render(<StatCard label="Open POs" value={6} />);
    const card = container.firstElementChild!;
    expect(card).toHaveClass('rounded-lg', 'border', 'bg-card');
    expect(card.className).not.toContain('shadow');
    expect(screen.getByText('6')).toHaveClass('text-[24px]', 'font-medium');
  });
});
