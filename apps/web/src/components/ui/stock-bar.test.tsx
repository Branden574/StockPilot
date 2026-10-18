import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockBar } from './stock-bar';

/**
 * Redesign P2.2 coverage bar (DESIGN-SPEC 6.11): 72 x 4 by default, on the
 * existing stock / par figure (no days-of-cover label; the app has no such
 * number). Before this fix the default stayed 80 and no caller passed a width,
 * so every bar shipped 80 wide.
 */

const track = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const fill = (container: HTMLElement) => track(container).firstElementChild as HTMLElement;

describe('StockBar', () => {
  it('is 72 x 4 by default', () => {
    const { container } = render(<StockBar stock={5} par={10} status="ok" />);
    expect(track(container).style.width).toBe('72px');
    expect(track(container).style.height).toBe('4px');
  });

  it('a caller can still pass its own width', () => {
    const { container } = render(<StockBar stock={5} par={10} status="ok" width={120} />);
    expect(track(container).style.width).toBe('120px');
  });

  it('fills stock / par exactly as before, clamped to 0..100, and 0 without a par', () => {
    const pct = (stock: number, par: number) =>
      fill(render(<StockBar stock={stock} par={par} status="warn" />).container).style.width;
    expect(pct(5, 10)).toBe('50%');
    expect(pct(30, 10)).toBe('100%');
    expect(pct(-4, 10)).toBe('0%');
    expect(pct(7, 0)).toBe('0%');
  });

  it('colours the fill by status and draws no label', () => {
    const { container } = render(<StockBar stock={1} par={10} status="crit" />);
    expect(fill(container).className).toContain('bg-[hsl(var(--destructive))]');
    expect(container.textContent).toBe('');
  });
});
