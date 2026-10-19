import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAD_INK, PAD_INK_QUIET, SignaturePad } from './signature-pad';

// jsdom has no canvas: the pad's drawing setup simply finds no 2D context.
// These tests pin the chrome drawn ON the fixed light canvas (P5.1).

afterEach(() => {
  document.documentElement.classList.remove('dark');
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

describe('SignaturePad chrome on the light canvas', () => {
  it('keeps the canvas light in dark mode, with touch-action none', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.documentElement.classList.add('dark');
    const { container } = render(<SignaturePad />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.backgroundColor.replace(/\s/g, '')).toMatch(/^(#fafaf7|rgb\(250,250,247\))$/i);
    const canvas = screen.getByRole('img', { name: 'Signature pad' });
    expect(canvas.style.touchAction).toBe('none');
  });

  it('draws "Sign here" and "Clear" in fixed inks that read on the canvas in both themes (they were theme greys: 2.5:1, and near-white on hover in dark)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.documentElement.classList.add('dark');
    render(<SignaturePad />);

    const hint = screen.getByText('Sign here');
    expect(hint.style.color.replace(/\s/g, '')).toMatch(/^(#5a5d56|rgb\(90,93,86\))$/i);
    expect(hint.className).not.toMatch(/text-muted-foreground|text-foreground/);

    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear.className).not.toMatch(/(^|\s)(hover:)?text-(muted-)?foreground(\s|$)/);
    expect(clear.style.getPropertyValue('--pad-ink-quiet')).toBe(PAD_INK_QUIET);
    expect(clear.style.getPropertyValue('--pad-ink')).toBe(PAD_INK);

    // WCAG AA for the words on the pad's own colour.
    expect(contrast(PAD_INK_QUIET, '#fafaf7')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PAD_INK, '#fafaf7')).toBeGreaterThanOrEqual(4.5);
  });

  it('gives Clear a 44 px target for one-handed use at the dock', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<SignaturePad />);
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear).toHaveAttribute('type', 'button');
    expect(clear.className).toMatch(/\bmin-h-11\b/);
    expect(clear.className).toMatch(/\bmin-w-11\b/);
  });
});
