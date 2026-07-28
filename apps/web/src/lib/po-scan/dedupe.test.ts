import { describe, expect, it } from 'vitest';

import { dropDuplicateNewIsbnLines } from './dedupe';
import type { ExtractedPo } from './extract';

type Line = ExtractedPo['lines'][number];

const line = (p: Partial<Line>): Line => ({
  lineNumber: 0,
  description: '',
  vendorSku: '',
  quantity: 0,
  uom: 'EA',
  unitPrice: 0,
  lineTotal: 0,
  lineType: 'inventory',
  confidence: 0.9,
  // Sports variant fields (Task 13). Empty is the "the document said
  // nothing" value — a book PO exercises the dedupe with all of them blank.
  size: '',
  sizeSystem: '',
  width: '',
  colorway: '',
  jerseyNumber: '',
  playerName: '',
  groupHint: '',
  serialNumber: '',
  mappingConfidence: null,
  ...p,
});

describe('dropDuplicateNewIsbnLines', () => {
  it('merges a priced title row with its "(NEW)+ISBN $0" twin (real PDF pattern)', () => {
    const lines: Line[] = [
      line({ lineNumber: 1, description: 'Sales Tax', lineType: 'tax', unitPrice: 24.08, quantity: 1, vendorSku: 'N/A' }),
      line({ lineNumber: 2, description: 'Hunger Games', unitPrice: 86.9, quantity: 10, vendorSku: 'N/A' }),
      line({ lineNumber: 3, description: 'Persepolis', unitPrice: 106.5, quantity: 10, vendorSku: 'N/A' }),
      line({ lineNumber: 4, description: 'Maus I, My Father Bleeds', unitPrice: 95, quantity: 10, vendorSku: 'N/A' }),
      line({ lineNumber: 5, description: '(NEW)MAUS I, MY FATHER BLEEDS HISTO SPIEGELMAN', unitPrice: 0, quantity: 10, vendorSku: '9780394747231' }),
      line({ lineNumber: 6, description: '(NEW)PERSEPOLIS', unitPrice: 0, quantity: 10, vendorSku: '9780375714573' }),
      line({ lineNumber: 7, description: '(NEW)HUNGER GAMES: BOOK 1', unitPrice: 0, quantity: 10, vendorSku: '9780439023528' }),
      line({ lineNumber: 8, description: 'Free Shipping', lineType: 'freight', unitPrice: 0, quantity: 1, vendorSku: 'FREIGHT' }),
    ];

    const out = dropDuplicateNewIsbnLines(lines);

    // 3 "(NEW)" dupes dropped -> 8 down to 5 (tax, 3 books, freight).
    expect(out).toHaveLength(5);
    expect(out.some((l) => /^\(NEW\)/i.test(l.description))).toBe(false);

    // ISBNs carried onto the priced twins.
    const maus = out.find((l) => l.description === 'Maus I, My Father Bleeds')!;
    const perse = out.find((l) => l.description === 'Persepolis')!;
    const hunger = out.find((l) => l.description === 'Hunger Games')!;
    expect(maus.vendorSku).toBe('9780394747231');
    expect(perse.vendorSku).toBe('9780375714573');
    expect(hunger.vendorSku).toBe('9780439023528');

    // Non-inventory rows untouched; line numbers re-sequenced.
    expect(out.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps a "(NEW)" line that has no matching priced twin (genuinely new item)', () => {
    const lines: Line[] = [
      line({ lineNumber: 1, description: 'Widget A', unitPrice: 5, quantity: 10, vendorSku: 'N/A' }),
      line({ lineNumber: 2, description: '(NEW)TOTALLY DIFFERENT PRODUCT', unitPrice: 0, quantity: 3, vendorSku: '111222333' }),
    ];
    const out = dropDuplicateNewIsbnLines(lines);
    expect(out).toHaveLength(2);
  });

  it('does not merge same-title lines when quantities differ', () => {
    const lines: Line[] = [
      line({ lineNumber: 1, description: 'Persepolis', unitPrice: 106.5, quantity: 40, vendorSku: 'N/A' }),
      line({ lineNumber: 2, description: '(NEW)PERSEPOLIS', unitPrice: 0, quantity: 10, vendorSku: '9780375714573' }),
    ];
    const out = dropDuplicateNewIsbnLines(lines);
    expect(out).toHaveLength(2);
  });

  it('returns the same array (no drops) when there are no (NEW) duplicates', () => {
    const lines: Line[] = [
      line({ lineNumber: 1, description: 'Persepolis', unitPrice: 106.5, quantity: 40, vendorSku: 'ABC' }),
    ];
    expect(dropDuplicateNewIsbnLines(lines)).toHaveLength(1);
  });
});
