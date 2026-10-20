import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from '@/components/ui/input';
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

  it('keeps the shared search field`s height beside it, with a 44 px touch target on coarse pointers', () => {
    render(
      <FilterBar>
        <Input aria-label="Search" />
        <FilterTrigger label="Category" aria-label="Filter by Category" />
      </FilterBar>,
    );
    const search = screen.getByRole('textbox', { name: 'Search' });
    const trigger = screen.getByRole('button', { name: 'Filter by Category' });
    // The field is 32 px, and 44 px only below sm (components/ui/input.tsx).
    expect(search).toHaveClass('h-8', 'max-sm:h-11');
    expect(search.className).not.toContain('pointer-coarse:');
    // The trigger follows it: 32 px, 44 px below sm. A visible 44 px on every
    // coarse pointer made a touch tablet's filter row 32 px field + 44 px
    // triggers; there it keeps 32 px and gets the Button's invisible target.
    expect(trigger).toHaveClass('h-8', 'max-sm:min-h-11', 'relative');
    expect(trigger).not.toHaveClass('pointer-coarse:min-h-11');
    expect(trigger).toHaveClass(
      'before:absolute',
      'before:min-h-11',
      'before:min-w-11',
      'before:content-none',
      "max-sm:before:content-['']",
      "pointer-coarse:before:content-['']",
    );
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
