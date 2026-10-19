/**
 * Settings > AI: the backfill panel keeps role="progressbar" with its values,
 * runs batches until nothing remains, and Stop ends the loop between batches
 * (the running batch finishes first).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/embeddings', () => ({ backfillItemEmbeddingsAction: vi.fn() }));

import { backfillItemEmbeddingsAction } from '@/server/actions/embeddings';

import { EmbeddingsBackfillPanel } from './embeddings-backfill-panel';

const backfill = vi.mocked(backfillItemEmbeddingsAction);

beforeEach(() => {
  backfill.mockReset();
});

describe('EmbeddingsBackfillPanel', () => {
  it('shows the progress as a progressbar with its values', () => {
    render(<EmbeddingsBackfillPanel initialRemaining={30} initialTotal={120} />);
    const bar = screen.getByRole('progressbar', { name: /items embedded/ });
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start backfill/ })).toBeEnabled();
  });

  it('offers Re-run when nothing remains', () => {
    render(<EmbeddingsBackfillPanel initialRemaining={0} initialTotal={10} />);
    expect(screen.getByRole('button', { name: /Re-run backfill/ })).toBeInTheDocument();
  });

  it('runs batches until nothing remains', async () => {
    backfill
      .mockResolvedValueOnce({
        ok: true,
        data: { embedded: 50, failed: 0, remaining: 50 },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        data: { embedded: 50, failed: 0, remaining: 0 },
      } as never);
    render(<EmbeddingsBackfillPanel initialRemaining={100} initialTotal={100} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Start backfill/ }));
    });
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('progressbar', { name: /items embedded/ })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    expect(screen.getByText('This session: 100 embedded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run backfill/ })).toBeInTheDocument();
  });

  it('stops between batches after Stop after current batch', async () => {
    let release: (() => void) | null = null;
    backfill.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, data: { embedded: 50, failed: 0, remaining: 50 } } as never);
        }),
    );
    render(<EmbeddingsBackfillPanel initialRemaining={100} initialTotal={100} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Start backfill/ }));
    });
    fireEvent.click(screen.getByRole('button', { name: /Stop after current batch/ }));
    await act(async () => {
      release?.();
    });
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Start backfill/ })).toBeInTheDocument();
  });
});
