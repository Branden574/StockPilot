import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Label } from './label';

/**
 * Redesign P2.2c (from P3.4): Label is 13 px with leading-none. An arbitrary
 * size such as text-[11px] sets no line height of its own, and cn()/twMerge
 * dropped leading-none beside it (a font size replaces an earlier leading), so
 * a resized Label inherited the surrounding line height (1.5, taller rows).
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('Label', () => {
  it('is 13 px / 500 with leading-none', () => {
    render(<Label>Item</Label>);
    expect(classes(screen.getByText('Item'))).toEqual(
      expect.arrayContaining(['text-[13px]', 'font-medium', 'leading-none']),
    );
  });

  it.each([
    'text-[11px]',
    'text-[10.5px] uppercase',
    'text-muted-foreground text-[11px]',
    'text-[0.7rem]',
  ])('keeps leading-none when a caller resizes it with %s', (className) => {
    render(<Label className={className}>Qty</Label>);
    const c = classes(screen.getByText('Qty'));
    expect(c).toContain('leading-none');
    expect(c).not.toContain('text-[13px]');
    for (const own of className.split(' ')) expect(c).toContain(own);
  });

  it("a caller's own line height still wins", () => {
    render(<Label className="text-[11px] leading-5">Qty</Label>);
    const c = classes(screen.getByText('Qty'));
    expect(c).toEqual(expect.arrayContaining(['text-[11px]', 'leading-5']));
    expect(c).not.toContain('leading-none');
  });

  it('an arbitrary colour is not a size: the 13 px size and leading-none stay', () => {
    render(<Label className="text-[var(--ed-ink-2)]">Qty</Label>);
    expect(classes(screen.getByText('Qty'))).toEqual(
      expect.arrayContaining(['text-[13px]', 'leading-none', 'text-[var(--ed-ink-2)]']),
    );
  });

  it('a named size keeps its own designed line height (unchanged)', () => {
    render(<Label className="text-xs">Weight</Label>);
    const c = classes(screen.getByText('Weight'));
    expect(c).toContain('text-xs');
    expect(c).not.toContain('leading-none');
  });
});
