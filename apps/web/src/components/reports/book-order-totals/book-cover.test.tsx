// The Book Order Totals cover: its larger preview is reachable from the
// keyboard (the cover is a focusable, labelled image, not a mouse-only
// target), dismissed with Escape (WCAG 1.4.13), and a missing or failed
// cover is a placeholder with its own words.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt } = props as { src: string; alt?: string };
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ''} />;
  },
}));

import { BookCover } from './book-cover';

const URL_A = 'https://proj.supabase.co/storage/v1/object/sign/item-images/o/a/cover.webp?token=t';

async function renderCover(source: { url: string | null; failed: boolean }) {
  const cover = Promise.resolve(source);
  await act(async () => {
    render(
      <div>
        <button type="button">Before</button>
        <BookCover cover={cover} title="Book A" />
      </div>,
    );
  });
}

describe('BookCover', () => {
  it('the cover is a focusable, labelled image, and focusing it opens the larger preview', async () => {
    const user = userEvent.setup();
    await renderCover({ url: URL_A, failed: false });
    const cover = screen.getByRole('img', { name: 'Cover of Book A' });
    expect(cover.tabIndex).toBe(0);
    await user.tab(); // Before
    await user.tab(); // the cover
    expect(cover).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('tooltip', { name: 'Cover of Book A' })).toBeInTheDocument());
  });

  it('Escape closes the preview without moving focus', async () => {
    const user = userEvent.setup();
    await renderCover({ url: URL_A, failed: false });
    const cover = screen.getByRole('img', { name: 'Cover of Book A' });
    act(() => cover.focus());
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(cover).toHaveFocus();
  });

  it('no cover and a cover that could not be loaded are placeholders with their own words, not tab stops', async () => {
    await renderCover({ url: null, failed: false });
    expect(screen.getByText('No cover')).toBeInTheDocument();
    expect(document.querySelector('[tabindex="0"]')).toBeNull();
  });

  it('a failed cover says it could not be loaded', async () => {
    await renderCover({ url: null, failed: true });
    expect(screen.getByText('Cover could not be loaded')).toBeInTheDocument();
  });
});
