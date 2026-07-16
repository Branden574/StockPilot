import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LocalDateTime } from './local-datetime';

describe('LocalDateTime', () => {
  it('renders the absolute local date+time after hydration', () => {
    const iso = '2026-07-15T22:28:00.000Z';
    render(<LocalDateTime iso={iso} prefix=" · " />);
    const expected = new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    // Effects run synchronously in the test renderer, so the text is present.
    expect(screen.getByText(`· ${expected}`, { exact: false })).toBeTruthy();
  });

  it('renders nothing (no dangling prefix) for an invalid date', () => {
    const { container } = render(<LocalDateTime iso="not-a-date" prefix=" · " />);
    expect(container.textContent).toBe('');
  });
});
