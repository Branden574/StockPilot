// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import TagsLoading from '@/app/(dashboard)/dashboard/tags/loading';

/**
 * The Tags route's skeleton (W-BK-11) in the page's final shape: the header
 * and the list card with one row per tag. It is busy, names what is loading
 * for a screen reader, and draws grey bars only (no words or figures).
 */
describe('Tags route skeleton', () => {
  it('tags/loading.tsx draws the list-shaped skeleton with no text but its label', () => {
    render(<TagsLoading />);
    const root = screen.getByTestId('tags-page-skeleton');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root.className).toContain('max-w-[1320px]');
    expect(root.textContent).toBe('Loading tags');
    expect(screen.getByText('Loading tags')).toHaveClass('sr-only');
  });
});
