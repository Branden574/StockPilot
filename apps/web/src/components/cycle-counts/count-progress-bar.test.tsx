import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CountProgressBar } from './count-progress-bar';

/**
 * The count progress bar only pictures figures printed next to it ("x of y
 * counted"), so it adds no number of its own and is hidden from assistive
 * technology; its fill never leaves the 0-100% track.
 */
function fillOf(container: HTMLElement): HTMLElement {
  const bar = container.querySelector('[data-slot="count-progress"]');
  if (!bar) throw new Error('no progress bar');
  return bar.firstElementChild as HTMLElement;
}

describe('CountProgressBar', () => {
  it('is hidden from assistive technology and prints no figure', () => {
    const { container } = render(<CountProgressBar counted={68} total={142} />);
    const bar = container.querySelector('[data-slot="count-progress"]');
    expect(bar).toHaveAttribute('aria-hidden');
    expect(bar).toHaveTextContent('');
  });

  it.each([
    [68, 142, `${(68 / 142) * 100}%`],
    [0, 10, '0%'],
    [10, 10, '100%'],
    [12, 10, '100%'],
    [-3, 10, '0%'],
    [0, 0, '0%'],
  ])('%i of %i fills %s', (counted, total, width) => {
    const { container } = render(<CountProgressBar counted={counted} total={total} />);
    expect(fillOf(container).style.width).toBe(width);
  });
});
