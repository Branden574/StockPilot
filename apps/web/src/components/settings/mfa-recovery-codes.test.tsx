import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MfaRecoveryCodes } from './mfa-recovery-codes';

import { generateMfaRecoveryCodesAction } from '@/server/actions/mfa-recovery';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const fakeCodes = Array.from({ length: 10 }, (_, i) => `code-${i + 1}`);

vi.mock('@/server/actions/mfa-recovery', () => ({
  generateMfaRecoveryCodesAction: vi.fn(async () => ({
    ok: true as const,
    data: { codes: fakeCodes },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MfaRecoveryCodes', () => {
  it('shows a Generate codes button and no warning when no codes exist', () => {
    render(<MfaRecoveryCodes total={0} unused={0} />);
    expect(
      screen.getByRole('button', { name: /Generate codes/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/running low/i)).not.toBeInTheDocument();
  });

  it('shows the running-low warning when unused <= 2 of total > 0', () => {
    render(<MfaRecoveryCodes total={10} unused={2} />);
    expect(screen.getByText(/running low/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Regenerate codes/i }),
    ).toBeInTheDocument();
  });

  it('does not show the warning when unused > 2', () => {
    render(<MfaRecoveryCodes total={10} unused={9} />);
    expect(screen.queryByText(/running low/i)).not.toBeInTheDocument();
    expect(screen.getByText(/9 of 10 recovery codes/i)).toBeInTheDocument();
  });

  it('clicking Generate calls the action and opens a dialog with all 10 codes', async () => {
    const user = userEvent.setup();
    render(<MfaRecoveryCodes total={0} unused={0} />);
    await user.click(screen.getByRole('button', { name: /Generate codes/i }));
    await waitFor(() => {
      expect(generateMfaRecoveryCodesAction).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    for (const code of fakeCodes) {
      expect(screen.getByText(code)).toBeInTheDocument();
    }
  });

  it('Copy all writes the codes to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<MfaRecoveryCodes total={0} unused={0} />);
    await user.click(screen.getByRole('button', { name: /Generate codes/i }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: /Copy all/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(fakeCodes.join('\n'));
    });
  });

  it("'I've saved them' closes the dialog once codes have been copied or downloaded", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<MfaRecoveryCodes total={0} unused={0} />);
    await user.click(screen.getByRole('button', { name: /Generate codes/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Save-enforcement: the close button is disabled until codes are
    // copied or downloaded.
    const closeBtnBefore = screen.getByRole('button', {
      name: /Copy or download first/i,
    });
    expect(closeBtnBefore).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Copy all/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /I've saved them/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('regenerating with existing codes shows a destructive confirm first', async () => {
    const user = userEvent.setup();
    render(<MfaRecoveryCodes total={10} unused={8} />);
    await user.click(screen.getByRole('button', { name: /Regenerate codes/i }));
    // The destructive confirm should be visible BEFORE the action runs.
    expect(
      await screen.findByText(/Regenerate recovery codes\?/i),
    ).toBeInTheDocument();
    expect(generateMfaRecoveryCodesAction).not.toHaveBeenCalled();
  });
});
