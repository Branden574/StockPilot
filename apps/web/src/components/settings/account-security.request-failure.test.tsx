import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the account and security settings (devices, API keys, webhooks, the
// authenticator, recovery codes, deleting the account, the email change,
// avatar and logo, signing out from the code page) each awaited a Server
// Action with no catch. A call that got no answer (offline, a server error, a
// deploy) left the button spinning or a confirm that could not be closed,
// and nothing was said; the handlers with no busy flag failed in silence.
// Now each says what did not happen, inside its confirm where it has one;
// a redirect to sign-in says nothing.
// ---------------------------------------------------------------------------

const { push, refresh, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh, replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/server/actions/sessions', () => ({
  renameSessionAction: vi.fn(),
  revokeOtherSessionsAction: vi.fn(),
  revokeSessionAction: vi.fn(),
}));
vi.mock('@/server/actions/api-keys', () => ({
  createApiKeyAction: vi.fn(),
  revokeApiKeyAction: vi.fn(),
}));
vi.mock('@/server/actions/integration-endpoints', () => ({
  createIntegrationEndpointAction: vi.fn(),
  deleteIntegrationEndpointAction: vi.fn(),
  setIntegrationEndpointEnabledAction: vi.fn(),
  testIntegrationEndpointAction: vi.fn(),
}));
vi.mock('@/server/actions/mfa', () => ({
  enrollFactorAction: vi.fn(),
  unenrollFactorAction: vi.fn(),
  verifyEnrollmentAction: vi.fn(),
  challengeFactorAction: vi.fn(),
}));
vi.mock('@/server/actions/mfa-recovery', () => ({
  generateMfaRecoveryCodesAction: vi.fn(),
  consumeMfaRecoveryCodeAction: vi.fn(),
}));
vi.mock('@/server/actions/profile', () => ({
  deleteOwnAccountAction: vi.fn(),
  setAvatarUrlAction: vi.fn(),
  setOrgLogoUrlAction: vi.fn(),
}));
vi.mock('@/server/actions/email-change', () => ({
  cancelEmailChangeAction: vi.fn(),
  requestEmailChangeAction: vi.fn(),
  resendEmailChangeAction: vi.fn(),
}));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));

import { toast } from 'sonner';

import { MfaChallengeForm } from '@/components/auth/mfa-challenge-form';
import { createClient } from '@/lib/supabase/client';
import { createApiKeyAction, revokeApiKeyAction } from '@/server/actions/api-keys';
import { signOutAction } from '@/server/actions/auth';
import {
  cancelEmailChangeAction,
  requestEmailChangeAction,
  resendEmailChangeAction,
} from '@/server/actions/email-change';
import {
  createIntegrationEndpointAction,
  deleteIntegrationEndpointAction,
  setIntegrationEndpointEnabledAction,
  testIntegrationEndpointAction,
} from '@/server/actions/integration-endpoints';
import {
  enrollFactorAction,
  unenrollFactorAction,
  verifyEnrollmentAction,
} from '@/server/actions/mfa';
import { generateMfaRecoveryCodesAction } from '@/server/actions/mfa-recovery';
import {
  deleteOwnAccountAction,
  setAvatarUrlAction,
  setOrgLogoUrlAction,
} from '@/server/actions/profile';
import {
  renameSessionAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
} from '@/server/actions/sessions';

import { ActiveSessions } from './active-sessions';
import { ApiKeysPanel } from './api-keys-panel';
import { AvatarUploader } from './avatar-uploader';
import { DeleteAccountButton } from './delete-account-button';
import { EmailSettingsCard } from './email-settings-card';
import { MfaEnrollment } from './mfa-enrollment';
import { MfaRecoveryCodes } from './mfa-recovery-codes';
import { OrgLogoUploader } from './org-logo-uploader';
import { WebhooksPanel } from './webhooks-panel';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets a rejected call's catch and finally run. */
async function settle(call: () => void) {
  await waitFor(call);
  await new Promise((r) => setTimeout(r, 20));
}

const NOW = new Date().toISOString();
const SESSIONS = [
  {
    id: 's1',
    label: 'Chrome on macOS',
    customName: null,
    ip: '203.0.113.7',
    lastActiveAt: NOW,
    createdAt: NOW,
    isMfa: true,
    isCurrent: true,
  },
  {
    id: 's2',
    label: 'Safari on iPhone',
    customName: null,
    ip: '203.0.113.8',
    lastActiveAt: NOW,
    createdAt: NOW,
    isMfa: false,
    isCurrent: false,
  },
];

describe('signed-in devices when a request gets no answer', () => {
  it('Sign out says that device was not signed out and works again', async () => {
    vi.mocked(revokeSessionAction).mockRejectedValueOnce(offline());
    render(<ActiveSessions sessions={SESSIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'sign out that device'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });

  it('Sign out all other devices says so and works again', async () => {
    vi.mocked(revokeOtherSessionsAction).mockRejectedValueOnce(offline());
    render(<ActiveSessions sessions={SESSIONS} />);
    fireEvent.click(screen.getByRole('button', { name: /Sign out all other devices/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'sign out the other devices'),
      ),
    );
    expect(screen.getByRole('button', { name: /Sign out all other devices/ })).toBeEnabled();
  });

  it('a rename keeps the name typed and says the device was not renamed', async () => {
    vi.mocked(renameSessionAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<ActiveSessions sessions={SESSIONS} />);
    await user.click(screen.getByRole('button', { name: 'Rename Safari on iPhone' }));
    await user.type(screen.getByRole('textbox', { name: 'Rename Safari on iPhone' }), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save device name' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'rename the device'),
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Rename Safari on iPhone' })).toHaveValue('Phone');
    expect(screen.getByRole('button', { name: 'Save device name' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(revokeSessionAction).mockRejectedValueOnce(signInRedirect());
    render(<ActiveSessions sessions={SESSIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await settle(() => expect(revokeSessionAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('API keys when a request gets no answer', () => {
  // A key has no idempotency key: one made before the answer was lost is a
  // second key if made again.
  it('Create key says to look before trying again, keeps the form and works again', async () => {
    vi.mocked(createApiKeyAction).mockRejectedValueOnce(offline());
    render(<ApiKeysPanel apiKeys={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /New key/ }));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Zapier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the key was created', 'the API keys list'),
      ),
    );
    expect(screen.getByLabelText('Key name')).toHaveValue('Zapier');
    expect(screen.getByRole('button', { name: 'Create key' })).toBeEnabled();
  });

  it('Revoke (no busy flag) says the key was not revoked', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    vi.mocked(revokeApiKeyAction).mockRejectedValueOnce(offline());
    render(
      <ApiKeysPanel
        apiKeys={[
          {
            id: 'k1',
            name: 'Zapier',
            keyPrefix: 'sp_live_ab12',
            scopes: ['inventory:read'],
            createdAt: NOW,
            lastUsedAt: null,
            revokedAt: null,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Zapier' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'revoke the key')),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('webhooks when a request gets no answer', () => {
  const EP = {
    id: 'e1',
    type: 'slack' as const,
    url: 'https://hooks.example.com/services/ops',
    eventTypes: ['order.created'],
    enabled: true,
    description: 'Ops channel',
    lastDeliveryAt: null,
    lastStatus: null,
    hasSecret: false,
  };

  it('Add endpoint says to look before trying again and works again', async () => {
    vi.mocked(createIntegrationEndpointAction).mockRejectedValueOnce(offline());
    render(<WebhooksPanel endpoints={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add endpoint/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Webhook' }));
    fireEvent.change(screen.getByLabelText(/URL/), {
      target: { value: 'https://example.test/hook' },
    });
    const add = () => screen.getAllByRole('button', { name: /Add endpoint/ }).at(-1)!;
    fireEvent.click(add());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the endpoint was added', 'the endpoints list'),
      ),
    );
    expect(add()).toBeEnabled();
  });

  it('Send test, Disable and Delete (no busy flag) each say what did not happen', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    vi.mocked(testIntegrationEndpointAction).mockRejectedValueOnce(offline());
    vi.mocked(setIntegrationEndpointEnabledAction).mockRejectedValueOnce(offline());
    vi.mocked(deleteIntegrationEndpointAction).mockRejectedValueOnce(offline());
    render(<WebhooksPanel endpoints={[EP]} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Send test to Slack endpoint Ops channel' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'send the test')),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'turn the endpoint off'),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete Slack endpoint Ops channel' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'delete the endpoint'),
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(testIntegrationEndpointAction).mockRejectedValueOnce(signInRedirect());
    render(<WebhooksPanel endpoints={[EP]} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Send test to Slack endpoint Ops channel' }),
    );
    await settle(() => expect(testIntegrationEndpointAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the authenticator when a request gets no answer', () => {
  it('Set up authenticator app says so and works again', async () => {
    vi.mocked(enrollFactorAction).mockRejectedValueOnce(offline());
    render(<MfaEnrollment verifiedFactors={[]} policyRequired={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Set up authenticator app/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'start setting up the authenticator'),
      ),
    );
    expect(screen.getByRole('button', { name: /Set up authenticator app/ })).toBeEnabled();
  });

  // The key the authenticator app would be given; a placeholder.
  const SETUP_KEY = 'EXAMPLE';

  it('Verify & enable keeps the code and says the authenticator was not turned on', async () => {
    vi.mocked(enrollFactorAction).mockResolvedValueOnce({
      ok: true,
      data: {
        factorId: 'f-1',
        qrCode: 'data:image/png;base64,AA',
        secret: SETUP_KEY,
        uri: 'otpauth://x',
      },
    } as never);
    vi.mocked(verifyEnrollmentAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<MfaEnrollment verifiedFactors={[]} policyRequired={false} />);
    await user.click(screen.getByRole('button', { name: /Set up authenticator app/ }));
    await user.type(await screen.findByLabelText(/enter the 6-digit code/), '123456');
    await user.type(screen.getByLabelText(/confirm your password/), 'typed-value');
    await user.click(screen.getByRole('button', { name: /Verify & enable/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'turn on the authenticator'),
      ),
    );
    expect(screen.getByLabelText(/enter the 6-digit code/)).toHaveValue('123456');
    expect(screen.getByRole('button', { name: /Verify & enable/ })).toBeEnabled();
  });

  it('Disable says why inside the confirm, which can be closed', async () => {
    vi.mocked(unenrollFactorAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <MfaEnrollment
        verifiedFactors={[{ id: 'f-1', status: 'verified', friendlyName: 'Phone' }]}
        policyRequired={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Disable/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));
    const sentence = requestFailedMessage(offline(), 'turn off the authenticator');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refused Disable also says why inside the confirm', async () => {
    vi.mocked(unenrollFactorAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'Your organization requires MFA.' },
    } as never);
    const user = userEvent.setup();
    render(
      <MfaEnrollment
        verifiedFactors={[{ id: 'f-1', status: 'verified', friendlyName: 'Phone' }]}
        policyRequired={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Disable/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your organization requires MFA.',
    );
  });
});

describe('recovery codes when Regenerate gets no answer', () => {
  it('says why inside the confirm, and Regenerate works again', async () => {
    vi.mocked(generateMfaRecoveryCodesAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<MfaRecoveryCodes total={10} unused={9} />);
    await user.click(screen.getByRole('button', { name: /Regenerate codes/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
    const sentence = requestFailedMessage(offline(), 'make new recovery codes');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(within(dialog).getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  });
});

describe('Delete my account when the request gets no answer', () => {
  it('says why inside the dialog, which stays open and can be closed', async () => {
    vi.mocked(deleteOwnAccountAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<DeleteAccountButton />);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'DELETE');
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'delete your account'),
    );
    expect(replace).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(deleteOwnAccountAction).mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    render(<DeleteAccountButton />);
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'DELETE');
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await settle(() => expect(deleteOwnAccountAction).toHaveBeenCalled());
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the email change when a request gets no answer', () => {
  const PENDING = {
    email: 'current@example.com',
    pendingEmail: 'next@example.com',
    sentAt: NOW,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    expired: false,
    justChanged: false,
  };

  it('Resend verification says the email was not sent again, and works again', async () => {
    vi.mocked(resendEmailChangeAction).mockRejectedValueOnce(offline());
    render(<EmailSettingsCard {...PENDING} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'send the verification email again'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Resend verification' })).toBeEnabled();
  });

  it('Cancel change says the change was not cancelled and works again', async () => {
    vi.mocked(cancelEmailChangeAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<EmailSettingsCard {...PENDING} />);
    await user.click(screen.getByRole('button', { name: 'Cancel change' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel change' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'cancel the email change'),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel change' })).toBeEnabled();
  });

  it('Send verification (the change dialog) keeps what was typed and says so', async () => {
    vi.mocked(requestEmailChangeAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<EmailSettingsCard {...PENDING} pendingEmail={null} sentAt={null} expiresAt={null} />);
    await user.click(screen.getByRole('button', { name: 'Change email' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('New email'), 'new@example.com');
    await user.type(within(dialog).getByLabelText('Current password'), 'typed-value');
    await user.click(within(dialog).getByRole('button', { name: 'Send verification' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'send the verification email'),
      ),
    );
    expect(within(dialog).getByLabelText('New email')).toHaveValue('new@example.com');
    expect(within(dialog).getByRole('button', { name: 'Send verification' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(resendEmailChangeAction).mockRejectedValueOnce(signInRedirect());
    render(<EmailSettingsCard {...PENDING} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification' }));
    await settle(() => expect(resendEmailChangeAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('avatar and logo when the save gets no answer', () => {
  function storage() {
    const bucket = {
      upload: vi.fn(async () => ({ data: { path: 'p' }, error: null })),
      getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://example.com/image.png' } })),
    };
    vi.mocked(createClient).mockReturnValue({ storage: { from: () => bucket } } as never);
    return bucket;
  }
  const png = () => new File(['x'], 'photo.png', { type: 'image/png' });

  it('an avatar upload says the avatar was not updated and Upload works again', async () => {
    storage();
    vi.mocked(setAvatarUrlAction).mockRejectedValueOnce(offline());
    const { container } = render(
      <AvatarUploader
        userId="u-1"
        initialUrl={null}
        fullName="Sam Example"
        email="sam@example.com"
      />,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [png()] },
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'update your avatar'),
      ),
    );
    expect(screen.getByRole('button', { name: /Upload/ })).toBeEnabled();
  });

  it('Remove avatar says so and works again', async () => {
    vi.mocked(setAvatarUrlAction).mockRejectedValueOnce(offline());
    render(
      <AvatarUploader
        userId="u-1"
        initialUrl="https://example.com/old.png"
        fullName="Sam Example"
        email="sam@example.com"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'remove your avatar'),
      ),
    );
    expect(screen.getByRole('button', { name: /Remove/ })).toBeEnabled();
  });

  it('a logo upload and Remove logo say so and work again', async () => {
    storage();
    vi.mocked(setOrgLogoUrlAction)
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(offline());
    const { container } = render(
      <OrgLogoUploader organizationId="org-1" initialUrl="https://example.com/old.png" />,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [png()] },
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'update the logo')),
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'remove the logo')),
    );
    expect(screen.getByRole('button', { name: /Remove/ })).toBeEnabled();
  });
});

describe('Cancel and sign out on the code page', () => {
  it('a sign-out that answers with its redirect says nothing (the usual way out)', async () => {
    vi.mocked(signOutAction).mockRejectedValueOnce(signInRedirect());
    render(<MfaChallengeForm factors={[{ id: 'factor-1', friendlyName: 'Phone' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and sign out' }));
    await settle(() => expect(signOutAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a sign-out that gets no answer says so, and stays on the page', async () => {
    vi.mocked(signOutAction).mockRejectedValueOnce(offline());
    render(<MfaChallengeForm factors={[{ id: 'factor-1', friendlyName: 'Phone' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and sign out' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'sign you out')),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
