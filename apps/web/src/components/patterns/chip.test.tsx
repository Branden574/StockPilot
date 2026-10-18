import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { FilterChip, FilterChipLink, MetaChip, chipActionClass, filterChipClass } from './chip';
import { SizeBadge } from './size-badge';

describe('FilterChip', () => {
  it('is a toggle button with aria-pressed, ink-filled when pressed', () => {
    const onClick = vi.fn();
    render(
      <FilterChip pressed onClick={onClick}>
        Auto-archived only
      </FilterChip>,
    );
    const chip = screen.getByRole('button', { name: 'Auto-archived only' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveAttribute('type', 'button');
    expect(chip).toHaveClass('bg-foreground', 'text-background');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('prints a count only where the page passes one', () => {
    const { container, rerender } = render(<FilterChip>Expected</FilterChip>);
    expect(container.querySelector('[data-slot="chip-count"]')).toBeNull();
    rerender(<FilterChip count={4}>Expected</FilterChip>);
    expect(container.querySelector('[data-slot="chip-count"]')).toHaveTextContent('4');
  });

  it('has no aria-pressed when it is not a toggle', () => {
    render(<FilterChip dashed>+ Save view</FilterChip>);
    const chip = screen.getByRole('button', { name: '+ Save view' });
    expect(chip).not.toHaveAttribute('aria-pressed');
    expect(chip).toHaveClass('border-dashed');
  });
});

describe('FilterChipLink and filterChipClass', () => {
  it('keeps the href and the caller`s attributes', () => {
    render(
      <FilterChipLink href="/dashboard/movements?type=receive_po" active aria-current="page">
        Receive PO
      </FilterChipLink>,
    );
    const link = screen.getByRole('link', { name: 'Receive PO' });
    expect(link).toHaveAttribute('href', '/dashboard/movements?type=receive_po');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveClass('bg-foreground');
  });

  it('gives the same look to an element the page already renders', () => {
    expect(filterChipClass({ active: true })).toContain('bg-foreground');
    expect(filterChipClass()).toContain('border-[var(--ed-line-strong)]');
    expect(filterChipClass({ size: 'md' })).toContain('h-[30px]');
  });
});

describe('MetaChip', () => {
  it('prints the chip, with its action as a sibling, never inside it', () => {
    render(
      <MetaChip
        action={
          <button type="button" className={chipActionClass}>
            Add to group
          </button>
        }
      >
        Same SKU as records in Polos
      </MetaChip>,
    );
    const chip = screen
      .getByText('Same SKU as records in Polos')
      .closest('[data-slot="meta-chip"]')!;
    const action = screen.getByRole('button', { name: 'Add to group' });
    expect(chip.contains(action)).toBe(false);
    expect(chip.parentElement!.contains(action)).toBe(true);
  });

  it('renders the bare chip without an action', () => {
    const { container } = render(<MetaChip title="In group Polos">In group Polos</MetaChip>);
    const chip = container.querySelector('[data-slot="meta-chip"]')!;
    expect(chip).toHaveAttribute('title', 'In group Polos');
    expect(chip.parentElement).toBe(container);
  });
});

describe('SizeBadge', () => {
  it('prints the page`s label unchanged, outlined in a row and filled on a card', () => {
    const { rerender } = render(<SizeBadge>4 variants · 96 pairs total</SizeBadge>);
    expect(screen.getByText('4 variants · 96 pairs total')).toHaveClass(
      'border',
      'whitespace-nowrap',
    );
    rerender(<SizeBadge placement="grid">8 sizes</SizeBadge>);
    expect(screen.getByText('8 sizes')).toHaveClass('bg-card');
  });

  it('cuts a long grid label off at its end, never its start; a row badge never truncates', () => {
    const long = '14 variants · 1,240 pairs total';
    const { rerender } = render(<SizeBadge placement="grid">{long}</SizeBadge>);
    const grid = screen.getByText(long);
    // inline-block + truncate: an ellipsis after "1,240 pai", so the leading
    // "14" always shows (an inline-flex nowrap pill grew left past the tile).
    expect(grid).toHaveClass('inline-block', 'max-w-full', 'truncate', 'whitespace-nowrap');
    expect(grid).not.toHaveClass('inline-flex');
    expect(grid.textContent).toBe(long);

    rerender(<SizeBadge>{long}</SizeBadge>);
    const row = screen.getByText(long);
    expect(row).toHaveClass('inline-flex', 'whitespace-nowrap');
    expect(row).not.toHaveClass('truncate');
  });
});
