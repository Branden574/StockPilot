import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PatternPhoto } from './photo';
import { Thumb } from './thumb';

describe('PatternPhoto', () => {
  it('covers by default and contains when asked', () => {
    const { rerender } = render(<PatternPhoto src="https://example.test/a.webp" alt="Mug" />);
    expect(screen.getByRole('img', { name: 'Mug' })).toHaveClass('object-cover');
    rerender(<PatternPhoto src="https://example.test/a.webp" alt="Mug" fit="contain" />);
    expect(screen.getByRole('img', { name: 'Mug' })).toHaveClass('object-contain');
  });

  it('swaps a failed image for the hatch, and tries a new source again', () => {
    const { container, rerender } = render(
      <PatternPhoto src="https://example.test/old.webp" alt="Mug" />,
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('[data-slot="missing-photo"]')).toHaveAttribute('aria-hidden');

    rerender(<PatternPhoto src="https://example.test/new.webp" alt="Mug" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.test/new.webp');
  });
});

describe('PatternPhoto: an error the server-rendered image hit before hydration', () => {
  /**
   * The image's state as the photo sees it once attached (happy-dom loads no
   * images, so the test decides): `complete` with no pixels is what a browser
   * reports for a broken image. Every source set on an image is recorded;
   * React sets the source itself too, so each case compares with a loaded
   * image's mount.
   */
  const image = { complete: true, width: 0 };
  let sets: string[] = [];

  beforeEach(() => {
    image.complete = true;
    image.width = 0;
    sets = [];
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(
      () => image.complete,
    );
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(
      () => image.width,
    );
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
      this: HTMLImageElement,
      value: string,
    ) {
      sets.push(value);
      original.set!.call(this, value);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** How many times the source is set while a loaded image mounts. */
  function setsForALoadedImage(): number {
    image.width = 200;
    const { unmount } = render(<PatternPhoto src="https://example.test/loaded.webp" alt="" />);
    unmount();
    const n = sets.length;
    sets = [];
    image.width = 0;
    return n;
  }

  it('asks the browser again when the attached image finished with no pixels', () => {
    const baseline = setsForALoadedImage();
    render(<PatternPhoto src="https://example.test/expired.webp" alt="Mug" />);
    expect(sets).toHaveLength(baseline + 1);
    expect(sets.at(-1)).toBe('https://example.test/expired.webp');
    // The retried request's error now reaches the handler: the hatch shows.
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('leaves an image that is still loading alone', () => {
    const baseline = setsForALoadedImage();
    image.complete = false;
    render(<PatternPhoto src="https://example.test/slow.webp" alt="Mug" />);
    expect(sets).toHaveLength(baseline);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});

describe('Thumb', () => {
  it('frames the photo at a declared size on a white tile with a hairline', () => {
    const { container } = render(<Thumb size={32} src="https://example.test/a.webp" alt="" />);
    const frame = container.querySelector('[data-slot="thumb"]')!;
    expect(frame).toHaveClass('size-8', 'bg-white', 'border', 'overflow-hidden');
  });

  it('shows the hatch without a photo', () => {
    const { container } = render(<Thumb />);
    expect(container.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
  });
});
