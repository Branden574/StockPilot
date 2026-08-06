import { describe, expect, it } from 'vitest';

import robots from './robots';

/**
 * Pins the disallow list against a future regression removing an entry —
 * `/r/` and `/m/` both carry a public share/order token in the URL itself,
 * so search-engine indexing would put that token in a public cache and
 * make it enumerable (see robots.ts's own comment). Fix wave I5.
 */
describe('robots', () => {
  it('disallows every token-bearing public surface (/r/ and /m/)', () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule?.disallow).toContain('/r/');
    expect(rule?.disallow).toContain('/m/');
  });
});
