import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ProcedureListRow } from '@/server/services/procedures';

import { ProcedureCard } from './procedure-card';

function row(overrides: Partial<ProcedureListRow> = {}): ProcedureListRow {
  return {
    id: 'p-1',
    title: 'Receiving a vendor delivery',
    description: null,
    category_id: 'c-1',
    category_name: 'Receiving',
    category_color: '#2563eb',
    authoring_warehouse_id: 'wh-1',
    authoring_warehouse_name: 'North DC',
    created_by: 'u-1',
    created_by_name: 'Dana Whitcombe',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    video_count: 0,
    comment_count: 0,
    thumbnail_url: null,
    thumbnail_kind: null,
    ...overrides,
  };
}

describe('ProcedureCard', () => {
  it('is one link to the detail page with the title, category, author line and counts', () => {
    render(<ProcedureCard procedure={row({ video_count: 2, comment_count: 3 })} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/dashboard/procedures/p-1');
    expect(
      screen.getByRole('heading', { level: 3, name: 'Receiving a vendor delivery' }),
    ).toBeInTheDocument();
    expect(link).toHaveTextContent('Receiving');
    expect(link).toHaveTextContent(/By Dana Whitcombe at North DC ·/);
    expect(link).toHaveTextContent('3 comments');
    expect(link).toHaveTextContent('2');
  });

  it('says "1 comment", and prints no comment line at zero', () => {
    const { rerender } = render(<ProcedureCard procedure={row({ comment_count: 1 })} />);
    expect(screen.getByRole('link')).toHaveTextContent('1 comment');
    rerender(<ProcedureCard procedure={row({ comment_count: 0 })} />);
    expect(screen.getByRole('link')).not.toHaveTextContent(/comment/);
  });

  it('without a video shows the flat fallback band in the category colour, never a gradient', () => {
    const { container } = render(<ProcedureCard procedure={row()} />);
    const band = container.querySelector('[data-slot="procedure-fallback-band"]') as HTMLElement;
    expect(band).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/gradient/);
    const stripe = band.querySelector('span') as HTMLElement;
    expect(stripe.style.backgroundColor).toMatch(/^(#2563eb|rgb\(37, 99, 235\))$/i);
  });

  it('falls back to slate for a procedure without a category, and "Unknown" without an author', () => {
    const { container } = render(
      <ProcedureCard
        procedure={row({
          category_name: null,
          category_color: null,
          created_by_name: null,
          authoring_warehouse_name: null,
        })}
      />,
    );
    const stripe = container.querySelector(
      '[data-slot="procedure-fallback-band"] span',
    ) as HTMLElement;
    expect(stripe.style.backgroundColor).toMatch(/^(#475569|rgb\(71, 85, 105\))$/i);
    expect(container.querySelector('[data-slot="procedure-category"]')).toBeNull();
    expect(screen.getByRole('link')).toHaveTextContent(/By Unknown ·/);
  });

  it('a poster renders as a lazy img; a legacy row renders the muted first-frame video', () => {
    const { container, rerender } = render(
      <ProcedureCard
        procedure={row({
          thumbnail_url: 'https://lab/poster.jpg',
          thumbnail_kind: 'poster',
          video_count: 1,
        })}
      />,
    );
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://lab/poster.jpg');
    expect(img).toHaveAttribute('loading', 'lazy');
    rerender(
      <ProcedureCard
        procedure={row({
          thumbnail_url: 'https://lab/clip.mp4',
          thumbnail_kind: 'video',
          video_count: 1,
        })}
      />,
    );
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video.muted).toBe(true);
  });
});
