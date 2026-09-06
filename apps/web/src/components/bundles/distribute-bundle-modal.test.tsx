import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockPreviewAction, mockDistributeAction, mockToast } = vi.hoisted(() => ({
  mockPreviewAction: vi.fn(),
  mockDistributeAction: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/server/actions/bundles', () => ({
  previewBundleDistributionAction: mockPreviewAction,
  distributeBundleAction: mockDistributeAction,
}));
vi.mock('sonner', () => ({ toast: mockToast }));

import { DistributeBundleModal } from './distribute-bundle-modal';

const PREVIEW = {
  fromPhantom: 1,
  fromComponents: 0,
  components: [],
  hasShortage: false,
  totalShortageItems: 0,
  totalShortageUnits: 0,
};

const CALCULATING = /Calculating preview/i;

function renderModal() {
  return render(
    <DistributeBundleModal
      bundleId="b-1"
      bundleName="Field Kit"
      warehouses={[{ id: 'w1', name: 'Main' }]}
    />,
  );
}

/** Drain the 200ms debounce plus the awaited action. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

/** Open the dialog and let the initial (quantity=1) preview land. */
async function openAndSettle() {
  fireEvent.click(screen.getByRole('button', { name: /^distribute$/i }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPreviewAction.mockReset();
  mockPreviewAction.mockResolvedValue({ ok: true, data: PREVIEW });
  mockDistributeAction.mockReset();
  mockToast.error.mockReset();
  mockToast.success.mockReset();
});

describe('DistributeBundleModal — preview spinner lifecycle', () => {
  it('clears the spinner when the quantity goes invalid mid-debounce', async () => {
    renderModal();
    await openAndSettle();
    expect(screen.getByText(/from pre-assembled stock/i)).toBeInTheDocument();

    const qty = screen.getByLabelText(/quantity/i);

    // Typing a new quantity arms a fresh 200ms debounce and flips `previewing`
    // on. The last good preview is still on screen, so the spinner stays hidden
    // (PreviewBlock only spins when previewing AND there is nothing to show).
    fireEvent.change(qty, { target: { value: '5' } });
    expect(screen.queryByText(CALCULATING)).not.toBeInTheDocument();

    // Now clear the box BEFORE that timer fires. The effect cleanup aborts the
    // debounce, so the callback that would have switched `previewing` back off
    // never runs — and the invalid branch nulls the preview. That combination is
    // exactly what left "Calculating preview…" spinning on an empty box forever.
    fireEvent.change(qty, { target: { value: '' } });
    await settle();

    expect(screen.queryByText(CALCULATING)).not.toBeInTheDocument();
    // No stale preview either, and nothing submittable.
    expect(screen.queryByText(/from pre-assembled stock/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Distribute .* kits?$/i })).toBeDisabled();

    // The valid path still works afterwards — the reset must not have wedged it.
    fireEvent.change(qty, { target: { value: '3' } });
    await settle();
    expect(mockPreviewAction).toHaveBeenLastCalledWith({
      id: 'b-1',
      quantity: 3,
      warehouseId: 'w1',
    });
    expect(screen.getByText(/from pre-assembled stock/i)).toBeInTheDocument();
  });

  it('still spins while a genuinely in-flight preview has nothing to show yet', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^distribute$/i }));

    // Debounce armed, no preview yet: this is the state the spinner exists for,
    // so a fix that simply stopped setting `previewing` would fail here.
    expect(screen.getByText(CALCULATING)).toBeInTheDocument();

    await settle();

    expect(mockPreviewAction).toHaveBeenCalledWith({
      id: 'b-1',
      quantity: 1,
      warehouseId: 'w1',
    });
    expect(screen.queryByText(CALCULATING)).not.toBeInTheDocument();
    expect(screen.getByText(/from pre-assembled stock/i)).toBeInTheDocument();
  });
});
