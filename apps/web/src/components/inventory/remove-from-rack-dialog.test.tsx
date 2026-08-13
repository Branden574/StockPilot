import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockRemoveStockFromLocationAction, mockToast } = vi.hoisted(() => ({
  mockRemoveStockFromLocationAction: vi.fn(),
  mockToast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/server/actions/inventory', () => ({
  removeStockFromLocationAction: mockRemoveStockFromLocationAction,
}));
vi.mock('sonner', () => ({ toast: mockToast }));

import { RemoveFromRackDialog } from './remove-from-rack-dialog';

// ---------------------------------------------------------------------------
// A write-off is the one path that EMPTIES a crate, and it used to say nothing
// at all about the book's crate label. Draining Blue #4 of every copy left the
// title reading "Blue 4" everywhere it is printed, and the operator was shown a
// plain "Removed 40 from Blue #4." — a picker walks to an empty crate.
//
// The dialog now reports what happened to the label, in the same words and the
// same order as the place / put-away dialogs report it.
// ---------------------------------------------------------------------------

function renderDialog() {
  return render(
    <RemoveFromRackDialog
      itemId="book-1"
      itemName="The Outsiders"
      locationId="c-blue4"
      locationName="Blue #4"
      holdingQuantity={40}
      trigger={<button type="button">Remove</button>}
    />,
  );
}

/** Open, fill the mandatory reason, submit. The quantity defaults to the whole
 *  holding, which is the "clear this crate" case these tests are about. */
async function removeWholeHolding(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^remove$/i }));
  await screen.findByRole('dialog');
  await user.type(screen.getByLabelText(/reason/i), 'Water damage');
  await user.click(screen.getByRole('button', { name: /remove stock/i }));
}

beforeEach(() => {
  mockRemoveStockFromLocationAction.mockReset();
  mockRemoveStockFromLocationAction.mockResolvedValue({ ok: true, data: {} });
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  mockToast.warning.mockReset();
});

describe('RemoveFromRackDialog — the crate label is never left silent', () => {
  it('WARNS when the write-off left the title with no stock in any rack or crate', async () => {
    const user = userEvent.setup();
    mockRemoveStockFromLocationAction.mockResolvedValue({
      ok: true,
      data: { crateSyncUnplaced: true },
    });
    renderDialog();
    await removeWholeHolding(user);

    expect(mockToast.success).toHaveBeenCalledWith('Removed 40 from Blue #4.');
    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders has no stock in a rack or crate now — its crate label was left unchanged and may be wrong.',
    );
  });

  it('WARNS when the label followed the stock — a relabel nobody asked for is still a write', async () => {
    // The operator typed "Blue 4" on a crate by hand. Draining one of two placed
    // holdings re-points that label at the crate the rest of the stock is in,
    // with no confirmation — the reconciliation is right, but it is a change to
    // a human-recorded value, and it must not be the ONE crate outcome that
    // reads as good news while its four neighbours all warn.
    const user = userEvent.setup();
    mockRemoveStockFromLocationAction.mockResolvedValue({
      ok: true,
      data: { crateSyncUpdated: true },
    });
    renderDialog();
    await removeWholeHolding(user);

    expect(mockToast.warning).toHaveBeenCalledWith(
      'The crate label on The Outsiders was changed to follow the stock it has left.',
    );
    // The write-off itself still succeeded, and says so — but that is the ONLY
    // success on this path. A second green toast about the label would put the
    // change back where it started.
    expect(mockToast.success).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledWith('Removed 40 from Blue #4.');
  });

  it('reports a concurrent re-crate, whose edit was left standing', async () => {
    const user = userEvent.setup();
    mockRemoveStockFromLocationAction.mockResolvedValue({
      ok: true,
      data: { crateSyncStale: true },
    });
    renderDialog();
    await removeWholeHolding(user);

    expect(mockToast.warning).toHaveBeenCalledWith(
      'Someone else changed the crate on The Outsiders while the stock was being removed — its label was left as they set it.',
    );
  });

  it('reports a split title, whose label was deliberately left alone', async () => {
    const user = userEvent.setup();
    mockRemoveStockFromLocationAction.mockResolvedValue({
      ok: true,
      data: { crateSyncSkipped: true },
    });
    renderDialog();
    await removeWholeHolding(user);

    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders still has stock in more than one location, so its crate label was left unchanged.',
    );
  });

  it('reports a FAILED label write ahead of every other bucket', async () => {
    const user = userEvent.setup();
    mockRemoveStockFromLocationAction.mockResolvedValue({
      ok: true,
      // Both flags: failed wins, same precedence as the placement dialogs.
      data: { crateSyncFailed: true, crateSyncUnplaced: true },
    });
    renderDialog();
    await removeWholeHolding(user);

    expect(mockToast.warning).toHaveBeenCalledTimes(1);
    expect(mockToast.warning).toHaveBeenCalledWith(
      'The crate label on The Outsiders could not be updated — check the book’s details.',
    );
  });

  it('a non-book write-off stays a plain success — no crate line invented', async () => {
    const user = userEvent.setup();
    renderDialog();
    await removeWholeHolding(user);

    expect(mockToast.success).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledWith('Removed 40 from Blue #4.');
    expect(mockToast.warning).not.toHaveBeenCalled();
  });
});
