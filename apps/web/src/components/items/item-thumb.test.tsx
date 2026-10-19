import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The hover preview is the shared primitive's job (tested with it); here we
// only read which image it was handed.
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({
    src,
    title,
    children,
  }: {
    src: string | null;
    title?: string | null;
    children: React.ReactNode;
  }) => (
    <div data-testid="preview" data-src={src ?? ''} data-title={title ?? ''}>
      {children}
    </div>
  ),
}));

import { ItemThumb } from './item-thumb';

/**
 * ItemThumb (PO lines, command palette). The redesign (P2.4, DESIGN-SPEC
 * 6.14): the photo on a hairline tile, the hatch when there is none, and the
 * hover preview of the larger image kept. Since P2.4c the tile and the hatch
 * are the shared Thumb and MissingPhoto patterns.
 */
describe('ItemThumb', () => {
  it('shows the small image and hands the larger one to the hover preview', () => {
    render(
      <ItemThumb
        imageUrl="https://x.test/thumb.webp"
        previewUrl="https://x.test/master.jpg"
        alt="Polo"
      />,
    );
    const img = screen.getByRole('img', { name: 'Polo' });
    expect(img).toHaveAttribute('src', 'https://x.test/thumb.webp');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(screen.getByTestId('preview')).toHaveAttribute('data-src', 'https://x.test/master.jpg');
    expect(screen.getByTestId('preview')).toHaveAttribute('data-title', 'Polo');
    expect(screen.queryByTestId('item-thumb-placeholder')).not.toBeInTheDocument();
  });

  it('previews the small image when there is no larger one', () => {
    render(<ItemThumb imageUrl="https://x.test/thumb.webp" alt="Polo" />);
    expect(screen.getByTestId('preview')).toHaveAttribute('data-src', 'https://x.test/thumb.webp');
  });

  // Defect caught in review: the photo sat on the sunk fill (near-black in
  // dark), so a cut-out of a dark product all but vanished at 28px in dark
  // mode. DESIGN-SPEC 4 and 6.14: every thumbnail photo is on white in both
  // themes; only the no-photo hatch is on sunk.
  it('puts the photo on a white tile in both themes', () => {
    render(<ItemThumb imageUrl="https://x.test/thumb.webp" alt="Polo" size="sm" />);
    const img = screen.getByRole('img', { name: 'Polo' });
    expect(img).toHaveClass('bg-white', 'object-cover');
    expect(img).not.toHaveClass('bg-sunk');
  });

  it('draws the hatch, not a broken image, when there is no photo or it fails to load', () => {
    const { rerender } = render(<ItemThumb imageUrl={null} alt="Polo" />);
    const hatch = screen.getByTestId('item-thumb-placeholder');
    expect(hatch).toHaveAttribute('aria-hidden', 'true');
    // Look only (P2.4c, the rebase onto P2.6): the hatch is now the shared
    // MissingPhoto pattern, which draws the strokes and the sunk fill in one
    // `background` shorthand instead of a backgroundImage over a bg-sunk class.
    // happy-dom's CSSOM drops a gradient in a shorthand that holds var(), so
    // the line-on-sunk hatch is read from the server-rendered markup, which
    // writes the style as given.
    expect(hatch).toHaveAttribute('data-slot', 'missing-photo');
    const markup = renderToString(<ItemThumb imageUrl={null} alt="Polo" />);
    expect(markup).toContain('data-testid="item-thumb-placeholder"');
    expect(markup).toMatch(
      /background:repeating-linear-gradient\(45deg, var\(--ed-line\)[^"]*\), var\(--ed-bg-sunk\)/,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview')).toHaveAttribute('data-src', '');

    rerender(<ItemThumb imageUrl="https://x.test/expired.webp" alt="Polo" />);
    fireEvent.error(screen.getByRole('img', { name: 'Polo' }));
    expect(screen.getByTestId('item-thumb-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview')).toHaveAttribute('data-src', '');
  });

  it('tries again with a fresh link or another item', () => {
    const { rerender } = render(
      <ItemThumb imageUrl="https://x.test/old.webp" alt="Polo" itemId="i1" />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Polo' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    rerender(<ItemThumb imageUrl="https://x.test/fresh.webp" alt="Polo" itemId="i1" />);
    expect(screen.getByRole('img', { name: 'Polo' })).toHaveAttribute(
      'src',
      'https://x.test/fresh.webp',
    );
  });

  it('keeps its two sizes: 28px (sm) and 40px (md, the default)', () => {
    // Look only (P2.4c): the size now sits on the shared Thumb frame around
    // the hatch or the photo, not on the hatch itself; the sizes are the same.
    const frame = () => screen.getByTestId('item-thumb-placeholder').closest('[data-slot="thumb"]');
    const { rerender } = render(<ItemThumb imageUrl={null} alt="Polo" size="sm" />);
    expect(frame()).toHaveClass('size-7', 'rounded-[5px]');
    rerender(<ItemThumb imageUrl={null} alt="Polo" />);
    expect(frame()).toHaveClass('size-10', 'rounded-md');
    // The 32px frame it is built on gives way to the 40px box.
    expect(frame()).not.toHaveClass('size-8');
  });

  // PLAN P2.4 / P2.6 "one owner per pattern": the frame and the hatch are the
  // shared patterns (patterns/thumb.tsx, patterns/missing-photo.tsx), so
  // ItemThumb, the grid card and the item cell show one frame and one hatch.
  it('draws its frame and its hatch through the shared patterns', () => {
    const { container, rerender } = render(
      <ItemThumb imageUrl="https://x.test/thumb.webp" alt="Polo" size="sm" />,
    );
    const img = screen.getByRole('img', { name: 'Polo' });
    const photoFrame = img.closest('[data-slot="thumb"]');
    expect(photoFrame).toHaveClass('bg-white', 'border', 'border-border', 'overflow-hidden');
    // The photo fills the frame, so the frame's rounded hairline clips it.
    expect(img).toHaveClass('absolute', 'inset-0', 'h-full', 'w-full');

    rerender(<ItemThumb imageUrl={null} alt="Polo" size="sm" />);
    const hatch = screen.getByTestId('item-thumb-placeholder');
    expect(hatch).toHaveAttribute('data-slot', 'missing-photo');
    expect(hatch.closest('[data-slot="thumb"]')).not.toBeNull();
    // One frame, one hatch: nothing of the old local tile is left beside them.
    expect(container.querySelectorAll('[data-slot="thumb"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="missing-photo"]')).toHaveLength(1);
  });
});

describe('ItemThumb: a photo that failed before the page hydrated', () => {
  // Mutation caught: a server-rendered thumbnail whose file is gone fired its
  // error before React listened, so onError never ran and the torn image with
  // its alt text stayed on the page (seen in the lab on a broken link).
  it('is asked for again after hydration, and its failure shows the hatch', async () => {
    const thumb = <ItemThumb imageUrl="https://x.test/gone.webp" alt="Gone" />;
    const container = document.createElement('div');
    container.innerHTML = renderToString(thumb);
    document.body.appendChild(container);
    const img = container.querySelector('img')!;
    // The browser's view of it: finished, no pixels (happy-dom reports every
    // image this way). Asking for it again fails again, as the file is gone.
    const refetches: string[] = [];
    Object.defineProperty(img, 'src', {
      configurable: true,
      get: () => img.getAttribute('src') ?? '',
      set: (value: string) => {
        refetches.push(value);
        setTimeout(() => img.dispatchEvent(new Event('error')), 0);
      },
    });

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(container, thumb);
    });

    expect(refetches).toEqual(['https://x.test/gone.webp']);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="item-thumb-placeholder"]')).not.toBeNull(),
    );
    expect(container.querySelector('img')).toBeNull();
    act(() => root!.unmount());
    container.remove();
  });
});
