import { describe, expect, it } from 'vitest';

import { FOCUS_SCROLL_INSET, focusScrollY, orderScreenFocus } from './order-focus';

describe('the order screen’s focus parameter (phone ordering PO-4)', () => {
  it('?focus=approve asks for the actions section; anything else for nothing', () => {
    expect(orderScreenFocus('approve')).toBe('actions');
    expect(orderScreenFocus(['approve'])).toBe('actions');
    expect(orderScreenFocus('actions')).toBe('actions');
    expect(orderScreenFocus(undefined)).toBeNull();
    expect(orderScreenFocus('cancel')).toBeNull();
    expect(orderScreenFocus(1)).toBeNull();
  });

  it('scrolls a little above the section, never before the top', () => {
    expect(focusScrollY(500)).toBe(500 - FOCUS_SCROLL_INSET);
    expect(focusScrollY(4)).toBe(0);
    expect(focusScrollY(Number.NaN)).toBeNull();
  });
});
