import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ELSEWHERE_UNAVAILABLE_NOTE } from '@stockpilot/core';

import { ElsewhereUnavailableNotice } from './elsewhere-unavailable-notice';

// The Items, Books and Rentals item lists share this wrapper, so the note
// cannot be dropped from one of them on its own (0371).
describe('ElsewhereUnavailableNotice', () => {
  it('a failed elsewhere read: the note, as a status, ABOVE the list', () => {
    const { container } = render(
      <ElsewhereUnavailableNotice unavailable>
        <table data-testid="list" />
      </ElsewhereUnavailableNotice>,
    );
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(ELSEWHERE_UNAVAILABLE_NOTE);
    expect(status?.nextElementSibling?.getAttribute('data-testid')).toBe('list');
  });

  it.each([false, undefined])('unavailable=%s: the list alone, nothing added', (unavailable) => {
    const { container } = render(
      <ElsewhereUnavailableNotice unavailable={unavailable}>
        <table data-testid="list" />
      </ElsewhereUnavailableNotice>,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.children).toHaveLength(1);
  });
});
