import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { PoScanForm } from './po-scan-form';

/**
 * The scan card in the redesign (P4.C1, matrix W-PU-06):
 *
 * - The drop zone is reachable from the keyboard (it was a click-only div):
 *   Tab reaches it, Enter or Space opens the file picker, with its words kept.
 * - The "Separate POs" / "One multi-page PO" choice says which one is on
 *   (aria-pressed), and Separate stays the default.
 * - The limits and the file types keep their words, HEIC included.
 */

function pdf(name: string): File {
  return new File([new Uint8Array(16)], name, { type: 'application/pdf' });
}

describe('PoScanForm drop zone and choice (redesign)', () => {
  it('opens the file picker from the keyboard as a click does', async () => {
    const user = userEvent.setup();
    render(<PoScanForm />);
    const input = screen.getByTestId('po-scan-file-input') as HTMLInputElement;
    const pick = vi.spyOn(input, 'click').mockImplementation(() => {});

    const zone = screen.getByRole('button', { name: /drop a photo or pdf of your po/i });
    expect(zone).toHaveTextContent('Up to 5 files · 8 MB each · JPEG, PNG, WEBP, HEIC, or PDF');

    await user.tab();
    await user.tab();
    expect(zone).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(pick).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('marks which of the two ways is chosen, Separate POs by default', async () => {
    const user = userEvent.setup();
    render(<PoScanForm />);
    await user.upload(screen.getByTestId('po-scan-file-input'), [pdf('a.pdf'), pdf('b.pdf')]);

    const separate = screen.getByRole('button', { name: /separate pos/i });
    const combined = screen.getByRole('button', { name: /one multi-page po/i });
    expect(separate).toHaveAttribute('aria-pressed', 'true');
    expect(combined).toHaveAttribute('aria-pressed', 'false');

    await user.click(combined);
    expect(separate).toHaveAttribute('aria-pressed', 'false');
    expect(combined).toHaveAttribute('aria-pressed', 'true');
  });
});
