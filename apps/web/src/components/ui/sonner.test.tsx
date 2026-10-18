import { act, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light' }) }));

import { Toaster } from './sonner';

/**
 * Redesign P2.2 toast look (DESIGN-SPEC 6.19).
 *
 * Defect fixed here: sonner injects its stylesheet unlayered, and an unlayered
 * rule beats every Tailwind utility (those sit in @layer utilities), so the
 * old `group-[.toaster]:bg-background ...` class names never reached a toast.
 * The look is now set through sonner's own CSS variables on the toaster
 * element, which an inline style always wins.
 */

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

describe('Toaster', () => {
  it('sets the toast colours through sonner variables: ink by default, the washes for warning and error', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('3 items archived.');
    });
    const toaster = (await screen.findByText('3 items archived.')).closest(
      '[data-sonner-toaster]',
    ) as HTMLElement;
    const v = (name: string) => toaster.style.getPropertyValue(name).trim();
    expect(v('--normal-bg')).toBe('hsl(var(--primary))');
    expect(v('--normal-text')).toBe('hsl(var(--primary-foreground))');
    expect(v('--success-bg')).toBe('hsl(var(--primary))');
    expect(v('--warning-bg')).toBe('hsl(var(--warning-wash))');
    expect(v('--warning-text')).toBe('hsl(var(--warning))');
    expect(v('--error-bg')).toBe('hsl(var(--destructive-wash))');
    expect(v('--error-text')).toBe('hsl(var(--destructive))');
    // The close button's hover keeps a fill its X can be read on.
    expect(v('--gray2')).toBe('hsl(var(--primary))');
    expect(toaster.style.fontFamily).toBe('var(--font-sans)');
  });

  it('keeps sonner in charge of position, rich colours and the close button', async () => {
    render(<Toaster />);
    act(() => {
      toast.error('Could not save. Nothing changed.');
    });
    const item = (await screen.findByText('Could not save. Nothing changed.')).closest(
      '[data-sonner-toast]',
    ) as HTMLElement;
    const toaster = item.closest('[data-sonner-toaster]') as HTMLElement;
    expect(toaster).toHaveAttribute('data-y-position', 'bottom');
    expect(toaster).toHaveAttribute('data-x-position', 'right');
    expect(item).toHaveAttribute('data-rich-colors', 'true');
    expect(item).toHaveAttribute('data-type', 'error');
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    // The error toast keeps its own close-button hover tone.
    expect(item.className).toContain('[--gray2:var(--error-bg)]');
  });

  it("a caller's style and toast options still apply on top", async () => {
    render(<Toaster style={{ zIndex: 5 }} toastOptions={{ style: { padding: '8px' } }} />);
    act(() => {
      toast('Saved the view.');
    });
    const item = (await screen.findByText('Saved the view.')).closest(
      '[data-sonner-toast]',
    ) as HTMLElement;
    const toaster = item.closest('[data-sonner-toaster]') as HTMLElement;
    expect(toaster.style.zIndex).toBe('5');
    expect(toaster.style.getPropertyValue('--normal-bg').trim()).toBe('hsl(var(--primary))');
    expect(item.style.padding).toBe('8px');
  });
});
