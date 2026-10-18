import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button, buttonVariants } from './button';

/**
 * Redesign P2.2 buttons (DESIGN-SPEC 6.2). The variant and size names are the
 * API of about 270 files and never change; the look under them does.
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('Button: the redesign look under the old names', () => {
  it('gradient is the flat accent primary: accent fill, on-accent ink, no gradient', () => {
    const c = buttonVariants({ variant: 'gradient' }).split(/\s+/);
    expect(c).toEqual(expect.arrayContaining(['bg-accent', 'text-accent-ink']));
    expect(
      c.some((x) => x.startsWith('bg-gradient') || x.startsWith('from-') || x.startsWith('to-')),
    ).toBe(false);
    expect(c).not.toContain('text-white');
  });

  it('default is the ink primary', () => {
    expect(buttonVariants({ variant: 'default' }).split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-primary', 'text-primary-foreground']),
    );
  });

  it('outline and ghost hover with the neutral fill, never the accent', () => {
    for (const variant of ['outline', 'ghost'] as const) {
      const c = buttonVariants({ variant }).split(/\s+/);
      expect(c).toContain('hover:bg-muted');
      expect(c.filter((x) => x.includes('accent'))).toEqual([]);
    }
    // The secondary button: card fill with the stronger hairline.
    expect(buttonVariants({ variant: 'outline' }).split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-card', 'border-[var(--ed-line-strong)]']),
    );
  });

  it('32 px by default, 28 small, 32 square for icons, radius 6', () => {
    expect(buttonVariants({}).split(/\s+/)).toEqual(expect.arrayContaining(['h-8', 'rounded-md']));
    expect(buttonVariants({ size: 'sm' }).split(/\s+/)).toContain('h-7');
    expect(buttonVariants({ size: 'icon' }).split(/\s+/)).toEqual(
      expect.arrayContaining(['h-8', 'w-8']),
    );
  });

  it('lg and xl keep their large sizes (48 and 56 px, 16 px text) for the large calls to action', () => {
    // Sign in, reset, MFA, Create organization, Change password, Complete
    // picking and Confirm & complete are deliberately large; their own
    // packages restyle them, so the primitive does not shrink them first.
    const lg = buttonVariants({ size: 'lg' }).split(/\s+/);
    expect(lg).toEqual(expect.arrayContaining(['h-12', 'px-8', 'text-base', 'rounded-md']));
    expect(lg).not.toContain('h-10');
    expect(buttonVariants({ size: 'xl' }).split(/\s+/)).toEqual(
      expect.arrayContaining(['h-14', 'px-10', 'text-base']),
    );
  });

  it('grows its hit area to 44 x 44 below sm and on coarse pointers, without changing its size', () => {
    const c = buttonVariants({ size: 'sm' }).split(/\s+/);
    expect(c).toEqual(
      expect.arrayContaining([
        'relative',
        'before:absolute',
        'before:min-h-11',
        'before:min-w-11',
        'before:content-none',
        "max-sm:before:content-['']",
        "pointer-coarse:before:content-['']",
      ]),
    );
    expect(c).toContain('h-7');
  });

  it("a caller's own size and colour still win", () => {
    render(
      <Button size="sm" className="bg-destructive h-9">
        Archive anyway
      </Button>,
    );
    const c = classes(screen.getByRole('button', { name: 'Archive anyway' }));
    expect(c).toContain('h-9');
    expect(c).not.toContain('h-7');
    expect(c).toContain('bg-destructive');
    expect(c).not.toContain('bg-primary');
  });
});

describe('Button: behaviour is unchanged', () => {
  it('renders a button that clicks, and asChild renders the child element', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button asChild variant="gradient">
        <a href="#new-item">New item</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'New item' });
    expect(link).toHaveAttribute('href', '#new-item');
    expect(classes(link)).toContain('bg-accent');
  });

  it('disabled does not click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Post count
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Post count' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
