import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { redirect, RedirectType } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Sage 50 wizard imports in chunks of 250 items, one Server Action each.
 * When the session ends partway through, the next chunk is answered with a
 * redirect to sign-in and the browser loads sign-in: the page unloads with the
 * running summary of what the earlier chunks imported. On every other failure
 * the wizard shows what did land, so after signing in it must still say so.
 */

const h = vi.hoisted(() => ({
  importSage50: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));
vi.mock('@/server/actions/sage50-import', () => ({
  importSage50Action: (...a: unknown[]) => h.importSage50(...a),
}));

import { purgeInterruptedRuns } from '@/lib/interrupted-run';
import { interruptedRunKeys } from '@/test/interrupted-run-fixtures';

import { Sage50ImportWizard } from './sage50-import-wizard';

const ME = { userId: 'user-1', organizationId: 'org-1' };
const STOPPED = 'The last import stopped when your session ended, after 250 of 300 items.';

function signInRedirect(): unknown {
  try {
    redirect('/signin?redirect=%2Fdashboard%2Fsettings%2Fmigrate%2Fsage50', RedirectType.push);
  } catch (e) {
    return e;
  }
  throw new Error('redirect() did not throw');
}

function chunkSummary(total: number, created: number) {
  return {
    ok: true,
    data: {
      items: {
        total,
        created,
        failed: total - created,
        errors: Array.from({ length: total - created }, (_, i) => ({
          row: i + 2,
          sku: `SKU-${i + 1}`,
          message: 'Already used by another record',
        })),
      },
      suppliers: {
        total: 0,
        created: 0,
        reused: 0,
        failed: 0,
        skipped: false,
        skippedReason: null,
      },
    },
  };
}

function itemListCsv(rows: number): File {
  const lines = ['Item ID,Item Description,Item Class'];
  for (let i = 1; i <= rows; i++) lines.push(`SKU-${i},Widget ${i},Stock item`);
  return new File([lines.join('\n')], 'items.csv', { type: 'text/csv' });
}

function renderWizard(account = ME) {
  return render(
    <Sage50ImportWizard
      warehouses={[{ id: 'w1', name: 'Main' }]}
      userId={account.userId}
      organizationId={account.organizationId}
    />,
  );
}

/** Load a 300-item list (two chunks) and press Import. */
async function importThreeHundredItems() {
  renderWizard();
  fireEvent.change(screen.getByLabelText('Sage 50 CSV files'), {
    target: { files: [itemListCsv(300)] },
  });
  await waitFor(() => expect(screen.getByText('300 items')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Import into StockPilot' }));
}

beforeEach(() => {
  sessionStorage.clear();
  for (const fn of Object.values(h)) fn.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Sage50ImportWizard: the session ends between chunks', () => {
  it('after signing in, the wizard shows what the import brought in before it stopped', async () => {
    h.importSage50
      .mockResolvedValueOnce(chunkSummary(250, 248))
      .mockRejectedValueOnce(signInRedirect());

    await importThreeHundredItems();
    await waitFor(() => expect(h.importSage50).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import into StockPilot' })).toBeEnabled(),
    );
    // Nothing is shown on the way to sign-in: the router is already going.
    expect(h.toastError).not.toHaveBeenCalled();
    expect(screen.queryByText(/created ·/)).toBeNull();

    // The browser loads sign-in; after signing in, the person is back here.
    cleanup();
    renderWizard();

    expect(await screen.findByText(STOPPED)).toBeInTheDocument();
    expect(screen.getByText(/248 created · 2 failed \(of 250\)/)).toBeInTheDocument();
    expect(screen.getByText('First 2 errors')).toBeInTheDocument();
    expect(
      screen.getByText(
        'To bring in the rest, load the same files and import again. The items already imported fail individually, and nothing gets overwritten.',
      ),
    ).toBeInTheDocument();
  });

  it('shows it once: the next visit starts clean', async () => {
    h.importSage50
      .mockResolvedValueOnce(chunkSummary(250, 250))
      .mockRejectedValueOnce(signInRedirect());
    await importThreeHundredItems();
    await waitFor(() => expect(h.importSage50).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import into StockPilot' })).toBeEnabled(),
    );

    cleanup();
    renderWizard();
    expect(await screen.findByText(STOPPED)).toBeInTheDocument();

    cleanup();
    renderWizard();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(STOPPED)).toBeNull();
  });

  it('another account signing in on this tab does not see it', async () => {
    h.importSage50
      .mockResolvedValueOnce(chunkSummary(250, 250))
      .mockRejectedValueOnce(signInRedirect());
    await importThreeHundredItems();
    await waitFor(() => expect(h.importSage50).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import into StockPilot' })).toBeEnabled(),
    );

    cleanup();
    renderWizard({ userId: 'user-1', organizationId: 'org-2' });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(STOPPED)).toBeNull();
    expect(screen.queryByText(/created ·/)).toBeNull();
  });

  it('an import that ends on the page leaves nothing behind', async () => {
    h.importSage50
      .mockResolvedValueOnce(chunkSummary(250, 250))
      .mockResolvedValueOnce(chunkSummary(50, 50));

    await importThreeHundredItems();
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Imported 300 of 300 items'));
    // Nothing is left in this tab for a later visit.
    expect(sessionStorage.length).toBe(0);

    cleanup();
    renderWizard();
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(STOPPED)).toBeNull();
    expect(screen.queryByText(/created ·/)).toBeNull();
  });

  it('an ordinary failure still shows what landed on the page, and leaves nothing behind', async () => {
    h.importSage50
      .mockResolvedValueOnce(chunkSummary(250, 250))
      .mockRejectedValueOnce(new Error('Failed to fetch'));

    await importThreeHundredItems();
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to fetch'));
    expect(screen.getByText(/250 created · 0 failed \(of 250\)/)).toBeInTheDocument();
    expect(screen.queryByText(STOPPED)).toBeNull();
    expect(sessionStorage.length).toBe(0);

    cleanup();
    renderWizard();
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(STOPPED)).toBeNull();
  });

  it('a chunk the server refuses shows what landed on the page, and leaves nothing behind', async () => {
    h.importSage50.mockResolvedValueOnce(chunkSummary(250, 250)).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'You do not have permission to import items.' },
    });

    await importThreeHundredItems();
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith('You do not have permission to import items.'),
    );
    expect(screen.getByText(/250 created · 0 failed \(of 250\)/)).toBeInTheDocument();
    expect(screen.queryByText(STOPPED)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('a sign-out on purpose while the import runs leaves nothing: the wizard opens clean after signing in', async () => {
    // B12 round 2. Three chunks: the first lands and is recorded; the person
    // signs out from the account menu (or the session is revoked) while the
    // second is on its way. The second still lands, and the wizard would
    // record it before sending the third, which the ended session answers
    // with a redirect.
    let finishSecond: (v: unknown) => void = () => {};
    h.importSage50
      .mockResolvedValueOnce(chunkSummary(250, 250))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      )
      .mockRejectedValueOnce(signInRedirect());

    renderWizard();
    fireEvent.change(screen.getByLabelText('Sage 50 CSV files'), {
      target: { files: [itemListCsv(600)] },
    });
    await waitFor(() => expect(screen.getByText('600 items')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import into StockPilot' }));
    await waitFor(() => expect(h.importSage50).toHaveBeenCalledTimes(2));
    expect(interruptedRunKeys()).toHaveLength(1);

    purgeInterruptedRuns();
    expect(interruptedRunKeys()).toEqual([]);

    finishSecond(chunkSummary(250, 250));
    await waitFor(() => expect(h.importSage50).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import into StockPilot' })).toBeEnabled(),
    );
    expect(interruptedRunKeys()).toEqual([]);

    cleanup();
    renderWizard();
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(/The last import stopped/)).toBeNull();
    expect(screen.queryByText(/created ·/)).toBeNull();
  });
});
