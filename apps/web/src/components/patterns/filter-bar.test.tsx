import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { FilterBar, FilterTrigger } from './filter-bar';

describe('FilterBar', () => {
  it('renders the view tabs and the filter cluster in one wrapping row', () => {
    const { container } = render(
      <FilterBar leading={<span>All items</span>} aria-label="Filters">
        <span>Category</span>
      </FilterBar>,
    );
    const row = container.querySelector('[data-slot="filter-bar"]')!;
    expect(row).toHaveClass('flex-wrap');
    expect(row.children).toHaveLength(2);
    expect(row.children[0]).toHaveTextContent('All items');
    expect(row.children[1]).toHaveTextContent('Category');
  });

  it('is a named group when the page names it, and a plain row otherwise', () => {
    const { container, rerender } = render(
      <FilterBar aria-label="Filters">
        <span>Search</span>
      </FilterBar>,
    );
    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument();
    rerender(
      <FilterBar>
        <span>Search</span>
      </FilterBar>,
    );
    expect(container.querySelector('[data-slot="filter-bar"]')).not.toHaveAttribute('role');
  });

  it('leaves out an empty group', () => {
    const { container } = render(
      <FilterBar>
        <span>Search</span>
      </FilterBar>,
    );
    expect(container.querySelector('[data-slot="filter-bar"]')!.children).toHaveLength(1);
  });
});

describe('FilterTrigger', () => {
  it('is a plain button with the label, and keeps the caller`s accessible name', () => {
    render(<FilterTrigger label="Category" aria-label="Filter by Category" />);
    const button = screen.getByRole('button', { name: 'Filter by Category' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveTextContent('Category');
  });

  it('prints the "Label: value" form with the value in 500', () => {
    render(<FilterTrigger label="Sort" value="Newest first" aria-label="Sort by Newest first" />);
    const button = screen.getByRole('button', { name: 'Sort by Newest first' });
    expect(button).toHaveTextContent('Sort:Newest first');
    expect(screen.getByText('Newest first')).toHaveClass('font-medium');
  });

  it('adds the active-count suffix only for a count above zero', () => {
    const { container, rerender } = render(<FilterTrigger label="Location" />);
    const count = () => container.querySelector('[data-slot="filter-trigger-count"]');
    expect(count()).toBeNull();
    rerender(<FilterTrigger label="Location" count={null} />);
    expect(count()).toBeNull();
    rerender(<FilterTrigger label="Location" count={0} />);
    expect(count()).toBeNull();
    expect(screen.getByRole('button')).not.toHaveAttribute('data-active');
    rerender(<FilterTrigger label="Location" count={3} />);
    expect(count()).toHaveTextContent('3');
    expect(screen.getByRole('button')).toHaveAttribute('data-active');
  });

  it('spreads handlers and the ref onto the button', () => {
    const onClick = vi.fn();
    const ref = React.createRef<HTMLButtonElement>();
    render(<FilterTrigger ref={ref} label="Charter" onClick={onClick} data-testid="charter" />);
    fireEvent.click(screen.getByTestId('charter'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(screen.getByRole('button'));
  });

  it('works as a Radix PopoverTrigger asChild child: one click opens its menu', () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <FilterTrigger label="Rack" value="Any" aria-label="Filter by rack" />
        </PopoverTrigger>
        <PopoverContent>Rack options</PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Filter by rack' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Rack options')).toBeInTheDocument();
  });
});
