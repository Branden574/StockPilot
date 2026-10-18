import { act, render, screen, within } from '@testing-library/react';
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

  it("close, action and cancel show a focus ring that beats sonner's own, and the toast takes the reference shadow", async () => {
    // Sonner's unlayered rings (black at 20% and 40%) were invisible on the ink
    // toast, and they beat the global :focus-visible ring. The trailing ! makes
    // these win; a keyboard user reaches them with Alt+T, then Tab.
    render(<Toaster />);
    act(() => {
      toast('3 items archived.', {
        action: { label: 'Undo', onClick: () => {} },
        cancel: { label: 'Keep', onClick: () => {} },
      });
    });
    const item = (await screen.findByText('3 items archived.')).closest(
      '[data-sonner-toast]',
    ) as HTMLElement;
    const ring =
      'focus-visible:[box-shadow:0_0_0_2px_var(--normal-bg),0_0_0_4px_var(--normal-text)]!';
    for (const name of [/close/i, 'Undo', 'Keep']) {
      const button = within(item).getByRole('button', { name });
      expect(button.className.split(/\s+/), String(name)).toContain(ring);
    }
    expect(item.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'shadow-[0_10px_30px_rgba(0,0,0,0.25)]!',
        'focus-visible:shadow-[0_10px_30px_rgba(0,0,0,0.25),0_0_0_2px_hsl(var(--ring))]!',
      ]),
    );
  });

  it('on the error and warning washes the button pair is turned round, so "Open it" stays readable', async () => {
    // item-form.tsx shows the SKU-taken error with "Group them" and "Open it".
    // Sonner fills the action pill with --normal-text and writes the cancel
    // words in --normal-text; with the ink pair the cancel words were
    // near-white on the pale wash (1.30:1) and the pill nearly the wash's
    // colour. Turned round: an ink pill with on-ink words, and ink cancel words.
    const turned = [
      '[--normal-bg:hsl(var(--primary-foreground))]',
      '[--normal-text:hsl(var(--primary))]',
    ];
    render(<Toaster />);
    act(() => {
      toast.error('That SKU is taken.', {
        action: { label: 'Group them', onClick: () => {} },
        cancel: { label: 'Open it', onClick: () => {} },
      });
      toast.warning('Some rows were skipped.');
      toast.success('Saved.');
    });
    const toastOf = async (text: string) =>
      (await screen.findByText(text)).closest('[data-sonner-toast]') as HTMLElement;
    const error = await toastOf('That SKU is taken.');
    expect(error.className.split(/\s+/)).toEqual(expect.arrayContaining(turned));
    expect(within(error).getByRole('button', { name: 'Group them' })).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: 'Open it' })).toBeInTheDocument();
    expect((await toastOf('Some rows were skipped.')).className.split(/\s+/)).toEqual(
      expect.arrayContaining(turned),
    );
    // The ink toast keeps the ink pair from the toaster.
    const success = (await toastOf('Saved.')).className.split(/\s+/);
    for (const cls of turned) expect(success).not.toContain(cls);
  });

  it("a caller's style and toast options still apply on top", async () => {
    render(
      <Toaster
        style={{ zIndex: 5 }}
        toastOptions={{ style: { padding: '8px' }, classNames: { closeButton: 'caller-close' } }}
      />,
    );
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
    // A caller's class names still replace the defaults key by key.
    expect(within(item).getByRole('button', { name: /close/i })).toHaveClass('caller-close');
  });
});
