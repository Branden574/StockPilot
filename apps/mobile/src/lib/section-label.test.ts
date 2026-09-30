import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sectionLabelText } from './section-label';

/**
 * New Item's section headings are one string on screen. A heading written as
 * `{sportsProfileLabel} VARIANT` reaches the component as TWO children,
 * ['SHOES', ' VARIANT'], and `String(children)` joined them with a comma, so
 * the phone showed "— SHOES, VARIANT" and "— SHOES, DETAILS" (simulator walk,
 * 2026-09-29), and VoiceOver read the comma too.
 */
describe('sectionLabelText', () => {
  it('joins a label written around an interpolation without a comma', () => {
    expect(sectionLabelText(['SHOES', ' VARIANT'])).toBe('SHOES VARIANT');
    expect(sectionLabelText(['GOALIE PADS', ' DETAILS'])).toBe('GOALIE PADS DETAILS');
  });

  it('keeps a plain label as it is', () => {
    expect(sectionLabelText('PHOTOS')).toBe('PHOTOS');
    expect(sectionLabelText('SIZES & QUANTITIES')).toBe('SIZES & QUANTITIES');
  });

  it('drops what React renders as nothing, keeps numbers, and flattens nesting', () => {
    expect(sectionLabelText(['A', null, undefined, false, true, 3])).toBe('A3');
    expect(sectionLabelText([['SHOES', ' '], 'VARIANT'])).toBe('SHOES VARIANT');
    expect(sectionLabelText(null)).toBe('');
  });
});

describe('item/new.tsx SectionLabel wiring', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/item/new.tsx'), 'utf8');

  it('renders its heading through sectionLabelText, never String(children)', () => {
    expect(screen).toContain('<Eyebrow>{sectionLabelText(children)}</Eyebrow>');
    expect(screen).not.toContain('String(children)');
  });
});
