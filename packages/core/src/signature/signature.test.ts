import { describe, expect, it } from 'vitest';
import {
  isValidSignatureDataUrl,
  pointsToSmoothSvgPath,
  pointsToSvgPath,
} from './index';

describe('pointsToSvgPath', () => {
  it('returns empty string for no points', () => {
    expect(pointsToSvgPath([])).toBe('');
  });

  it('returns M command for a single point', () => {
    expect(pointsToSvgPath([{ x: 10, y: 20 }])).toBe('M 10 20');
  });

  it('returns M + L commands for multiple points', () => {
    expect(
      pointsToSvgPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 5 },
      ]),
    ).toBe('M 0 0 L 10 10 L 20 5');
  });
});

describe('pointsToSmoothSvgPath', () => {
  it('falls back to the plain builder for fewer than 3 points', () => {
    expect(pointsToSmoothSvgPath([])).toBe('');
    expect(pointsToSmoothSvgPath([{ x: 1, y: 2 }])).toBe('M 1 2');
    expect(
      pointsToSmoothSvgPath([
        { x: 0, y: 0 },
        { x: 4, y: 4 },
      ]),
    ).toBe('M 0 0 L 4 4');
  });

  it('emits quadratic segments through midpoints, then a line to the last point', () => {
    // 4 points → 2 interior control points → 2 Q segments + a trailing L.
    expect(
      pointsToSmoothSvgPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ]),
    ).toBe('M 0 0 Q 10 0 10 5 Q 10 10 15 10 L 20 10');
  });

  it('does not mutate the input', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    const copy = JSON.parse(JSON.stringify(pts));
    pointsToSmoothSvgPath(pts);
    expect(pts).toEqual(copy);
  });
});

describe('isValidSignatureDataUrl', () => {
  it('accepts a valid png data URL', () => {
    expect(isValidSignatureDataUrl('data:image/png;base64,abc123=')).toBe(true);
  });

  it('accepts a valid jpeg data URL', () => {
    expect(isValidSignatureDataUrl('data:image/jpeg;base64,abc123=')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidSignatureDataUrl('')).toBe(false);
  });

  it('rejects arbitrary garbage', () => {
    expect(isValidSignatureDataUrl('garbage')).toBe(false);
  });

  it('rejects a non-image data URL (text/plain)', () => {
    expect(isValidSignatureDataUrl('data:text/plain;base64,abc')).toBe(false);
  });
});
