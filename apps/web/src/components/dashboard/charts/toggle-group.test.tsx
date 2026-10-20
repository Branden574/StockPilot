import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ToggleGroup } from './toggle-group';

/**
 * The analytics toggles (Range, Chart type, Breakdown dimension) now draw
 * through the shared SegmentedTabs; their semantics are unchanged: a named
 * group of real buttons with aria-pressed.
 */
describe('ToggleGroup', () => {
  const options = [
    { value: '30', label: '30d' },
    { value: '90', label: '90d' },
  ];

  it('is a named group of pressed / not pressed buttons', () => {
    render(<ToggleGroup aria-label="Range" options={options} value="30" onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Range' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '90d' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the chosen value', () => {
    const onChange = vi.fn();
    render(<ToggleGroup aria-label="Range" options={options} value="30" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '90d' }));
    expect(onChange).toHaveBeenCalledWith('90');
  });

  // FX7 (DESIGN-SPEC 4 and 6.5): Range, Chart type and Breakdown dimension
  // take the range toggle's size (a 28 px transparent track, 22 px chips),
  // not the 32 px List / Grid toggle's.
  it('draws the range toggle size (SegmentedTabs xs)', () => {
    render(<ToggleGroup aria-label="Range" options={options} value="30" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Range' });
    expect(group).toHaveClass('bg-transparent', 'p-0.5');
    expect(group).not.toHaveClass('bg-sunk');
    expect(screen.getByRole('button', { name: '30d' })).toHaveClass('h-[22px]', 'bg-muted');
    expect(screen.getByRole('button', { name: '90d' })).toHaveClass('h-[22px]', 'font-normal');
  });

  it('renders nothing with fewer than two options', () => {
    const { container } = render(
      <ToggleGroup aria-label="Range" options={[options[0]!]} value="30" onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
