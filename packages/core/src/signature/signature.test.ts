import { describe, expect, it } from 'vitest';
import { isValidSignatureDataUrl, pointsToSvgPath } from './index';

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
