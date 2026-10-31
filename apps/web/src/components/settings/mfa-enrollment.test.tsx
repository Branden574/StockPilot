import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings, Security: setting up an authenticator app (MfaEnrollment).
 *
 * Docket B50: authenticator apps show the code as "123 456". The Step 2 box
 * had a maxLength of 6, which cut a pasted copy at six characters, "123 45",
 * before the digits were kept: five digits, and Verify & enable stayed off.
 */

const enrollFactorAction = vi.fn();
const verifyEnrollmentAction = vi.fn();

vi.mock('@/server/actions/mfa', () => ({
  enrollFactorAction: (...a: unknown[]) => enrollFactorAction(...a),
  unenrollFactorAction: vi.fn(),
  verifyEnrollmentAction: (...a: unknown[]) => verifyEnrollmentAction(...a),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MfaEnrollment } from './mfa-enrollment';

// The set-up answer's typed-key text and what the test types into Step 3:
// dull values under neutral names (a secret- or password-shaped name holding a
// literal trips secret scanners whatever the value).
const SETUP_TEXT = 'setup-text';
const TYPED_VALUE = 'pw-123456';

beforeEach(() => {
  vi.clearAllMocks();
  enrollFactorAction.mockResolvedValue({
    ok: true,
    data: { factorId: 'factor-1', qrCode: 'about:blank', secret: SETUP_TEXT, uri: '' },
  });
  // Refused, so the test never reaches the hard navigation that follows a
  // finished set-up.
  verifyEnrollmentAction.mockResolvedValue({ ok: false, error: { message: 'Invalid code' } });
});

describe('MfaEnrollment', () => {
  it('a code pasted with a space in Step 2 is sent as six digits', async () => {
    const user = userEvent.setup();
    render(<MfaEnrollment verifiedFactors={[]} policyRequired={false} />);

    await user.click(screen.getByRole('button', { name: 'Set up authenticator app' }));
    const code = await screen.findByLabelText(/^Step 2/);
    await user.click(code);
    await user.paste('123 456');
    expect(code).toHaveValue('123456');
    await user.type(screen.getByLabelText(/^Step 3/), TYPED_VALUE);
    await user.click(screen.getByRole('button', { name: 'Verify & enable' }));

    await waitFor(() =>
      expect(verifyEnrollmentAction).toHaveBeenCalledWith({
        factorId: 'factor-1',
        code: '123456',
        password: TYPED_VALUE,
      }),
    );
  });
});
