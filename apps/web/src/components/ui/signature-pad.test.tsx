import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAD_INK_QUIET, SignaturePad, type SignaturePadHandle } from './signature-pad';

// jsdom has no canvas: the pad's drawing setup simply finds no 2D context.
// These tests pin the chrome around the fixed light canvas (P5.1).

afterEach(() => {
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

function hexToLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [hexToLuminance(a), hexToLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The drawing box: the canvas's own parent, which carries the light fill. */
function drawingBox(): HTMLElement {
  return screen.getByRole('img', { name: 'Signature pad' }).parentElement as HTMLElement;
}

describe('SignaturePad chrome around the light canvas', () => {
  it('keeps the canvas light in dark mode, with touch-action none', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.documentElement.classList.add('dark');
    render(<SignaturePad />);
    // Located through the canvas: the box is no longer the root, since the
    // Clear row now sits under it (review finding, P5.1).
    const box = drawingBox();
    expect(box.style.backgroundColor.replace(/\s/g, '')).toMatch(/^(#fafaf7|rgb\(250,250,247\))$/i);
    const canvas = screen.getByRole('img', { name: 'Signature pad' });
    expect(canvas.style.touchAction).toBe('none');
  });

  it('draws "Sign here" on the pad in a fixed ink that reads on the canvas in both themes (it was a theme grey: 2.5:1 in dark)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.documentElement.classList.add('dark');
    render(<SignaturePad />);

    const hint = screen.getByText('Sign here');
    expect(drawingBox()).toContainElement(hint);
    expect(hint.style.color.replace(/\s/g, '')).toMatch(/^(#5a5d56|rgb\(90,93,86\))$/i);
    expect(hint.className).not.toMatch(/text-muted-foreground|text-foreground/);

    // WCAG AA for the words on the pad's own colour.
    expect(contrast(PAD_INK_QUIET, '#fafaf7')).toBeGreaterThanOrEqual(4.5);
  });

  it('puts Clear in its own row under the pad, never over the canvas, so a stroke near the corner is not lost and a tap there does not wipe the signature', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<SignaturePad />);
    const clear = screen.getByRole('button', { name: 'Clear' });
    const box = drawingBox();

    expect(box).not.toContainElement(clear);
    expect(box.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.firstElementChild).toContainElement(box);
    expect(container.firstElementChild).toContainElement(clear);
    // Off the fixed light pad it sits on the theme card, so it takes the
    // theme's colours (the pad's fixed inks were only for words on the pad).
    expect(clear.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['text-muted-foreground', 'hover:text-foreground']),
    );
    expect(clear.className).not.toMatch(/absolute|pad-ink/);
    expect(clear.getAttribute('style')).toBeNull();
  });

  it('gives Clear a 44 px target for one-handed use at the dock', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<SignaturePad />);
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear).toHaveAttribute('type', 'button');
    expect(clear.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(clear.className).toMatch(/(^|\s)min-w-11(\s|$)/);
  });

  it('Clear still empties the pad: the hint comes back, onChange hears empty, and the handle reports empty', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const onChange = vi.fn();
    const ref = createRef<SignaturePadHandle>();
    render(<SignaturePad ref={ref} onChange={onChange} />);
    expect(ref.current?.isEmpty()).toBe(true);

    fireEvent.pointerDown(screen.getByRole('img', { name: 'Signature pad' }), {
      clientX: 10,
      clientY: 10,
    });
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('Sign here')).toBeNull();
    expect(ref.current?.isEmpty()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Sign here')).toBeInTheDocument();
    expect(ref.current?.isEmpty()).toBe(true);
  });
});
