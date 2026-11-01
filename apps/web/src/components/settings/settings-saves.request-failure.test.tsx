import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, outOfDate, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: each of these settings saves set a busy flag, awaited its Server Action
// with no catch and cleared the flag only when the action answered. A call
// that got no answer (offline, a server error, a deploy that no longer has the
// action) left the button spinning and disabled for good, and nothing was
// said. Now the button works again and says what did not happen; a page older
// than the server says to reload; a redirect to sign-in says nothing.
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
}));
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));
vi.mock('@/server/actions/inventory-cleanup-settings', () => ({
  setAutoDeleteArchivedSettingsAction: vi.fn(),
}));
vi.mock('@/server/actions/auto-archive-settings', () => ({
  setAutoArchiveSettingsAction: vi.fn(),
}));
vi.mock('@/server/actions/auto-reorder-settings', () => ({
  setAutoReorderSettingsAction: vi.fn(),
}));
vi.mock('@/server/actions/restore-points', () => ({
  createRestorePointAction: vi.fn(),
  restoreFromPointAction: vi.fn(),
  restorePointSkuChangesAction: vi.fn(),
}));
vi.mock('@/server/actions/mfa', () => ({ setOrgMfaPolicyAction: vi.fn() }));
vi.mock('@/server/actions/organization', () => ({
  renameOrganizationAction: vi.fn(),
  updateOrgTimezoneAction: vi.fn(),
  updateOrgPoTermsAction: vi.fn(),
}));
vi.mock('@/server/actions/planning-settings', () => ({ setPlanningParamsAction: vi.fn() }));
vi.mock('@/server/actions/po-approval-settings', () => ({
  setPoApprovalSettingsAction: vi.fn(),
}));
vi.mock('@/server/actions/profile', () => ({ updateProfileNameAction: vi.fn() }));
vi.mock('@/server/actions/embeddings', () => ({ backfillItemEmbeddingsAction: vi.fn() }));
vi.mock('@/server/actions/recovery', () => ({ restoreDeletedAction: vi.fn() }));
vi.mock('@/server/actions/zendesk', () => ({ setZendeskSubdomainAction: vi.fn() }));
vi.mock('@/server/actions/purchase-orders', () => ({
  createDraftPosFromReorderForecastAction: vi.fn(),
}));

import { toast } from 'sonner';

import { DraftPosFromReorderButton } from '@/components/reports/draft-pos-from-reorder-button';
import { ZendeskQuickAccess } from '@/components/zendesk/zendesk-quick-access';
import { setAutoArchiveSettingsAction } from '@/server/actions/auto-archive-settings';
import { setAutoReorderSettingsAction } from '@/server/actions/auto-reorder-settings';
import { backfillItemEmbeddingsAction } from '@/server/actions/embeddings';
import { setAutoDeleteArchivedSettingsAction } from '@/server/actions/inventory-cleanup-settings';
import { setOrgMfaPolicyAction } from '@/server/actions/mfa';
import {
  renameOrganizationAction,
  updateOrgPoTermsAction,
  updateOrgTimezoneAction,
} from '@/server/actions/organization';
import { setPlanningParamsAction } from '@/server/actions/planning-settings';
import { setPoApprovalSettingsAction } from '@/server/actions/po-approval-settings';
import { updateProfileNameAction } from '@/server/actions/profile';
import { createDraftPosFromReorderForecastAction } from '@/server/actions/purchase-orders';
import { restoreDeletedAction } from '@/server/actions/recovery';
import {
  createRestorePointAction,
  restoreFromPointAction,
  restorePointSkuChangesAction,
} from '@/server/actions/restore-points';
import { setZendeskSubdomainAction } from '@/server/actions/zendesk';

import { ArchiveCleanupPanel } from './archive-cleanup-panel';
import { AutoArchivePanel } from './auto-archive-panel';
import { AutoReorderPanel } from './auto-reorder-panel';
import { CreateRestorePointButton } from './create-restore-point-button';
import { EmbeddingsBackfillPanel } from './embeddings-backfill-panel';
import { MfaPolicyEditor } from './mfa-policy-editor';
import { OrgNameEditor } from './org-name-editor';
import { OrgTimezoneEditor } from './org-timezone-editor';
import { PlanningParamsPanel } from './planning-params-panel';
import { PoApprovalPanel } from './po-approval-panel';
import { PoTermsEditor } from './po-terms-editor';
import { ProfileNameEditor } from './profile-name-editor';
import { RestoreButton } from './restore-button';
import { RestoreSnapshotButton } from './restore-snapshot-button';

beforeAll(() => {
  // Radix Select needs pointer-capture APIs happy-dom doesn't implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
});

interface Case {
  name: string;
  action: Mock;
  ui: () => React.ReactElement;
  /** Makes the change (if the button needs one) and presses the button. */
  press: (user: UserEvent) => Promise<void>;
  /** The button that must work again. */
  button: string | RegExp;
  sentence: (e: unknown) => string;
  /** Also said in the panel's own error line (role="alert"). */
  inline?: boolean;
  /** What makes the button pressable again after the failure, when it needs a change. */
  again?: (user: UserEvent) => Promise<void>;
}

const CASES: Case[] = [
  {
    name: 'Inventory cleanup Save settings',
    action: vi.mocked(setAutoDeleteArchivedSettingsAction),
    ui: () => (
      <ArchiveCleanupPanel
        initial={{ enabled: false, days: 90 }}
        archivedCount={0}
        windowedCounts={{}}
      />
    ),
    press: (user) => user.click(screen.getByRole('button', { name: /Save settings/ })),
    button: /Save settings/,
    sentence: (e) => requestFailedMessage(e, 'save the cleanup settings'),
  },
  {
    name: 'Auto-archive Save settings',
    action: vi.mocked(setAutoArchiveSettingsAction),
    ui: () => <AutoArchivePanel initial={{ enabled: false, dwellDays: 30 }} eligibleCount={0} />,
    press: (user) => user.click(screen.getByRole('button', { name: /Save settings/ })),
    button: /Save settings/,
    sentence: (e) => requestFailedMessage(e, 'save the auto-archive settings'),
    inline: true,
  },
  {
    name: 'Auto-reorder Save settings',
    action: vi.mocked(setAutoReorderSettingsAction),
    ui: () => (
      <AutoReorderPanel
        initial={{ enabled: false, mode: 'draft', maxAutoSendCents: null }}
        entitled
      />
    ),
    press: (user) => user.click(screen.getByRole('button', { name: /Save settings/ })),
    button: /Save settings/,
    sentence: (e) => requestFailedMessage(e, 'save the auto-reorder settings'),
  },
  {
    // A restore point has no key: one made before the answer was lost is a
    // second one if made again.
    name: 'Create restore point',
    action: vi.mocked(createRestorePointAction),
    ui: () => <CreateRestorePointButton />,
    press: (user) => user.click(screen.getByRole('button', { name: /Create restore point/ })),
    button: /Create restore point/,
    sentence: (e) =>
      requestUnconfirmedMessage(e, 'the restore point was created', 'the restore points list'),
  },
  {
    name: 'MFA policy Save policy',
    action: vi.mocked(setOrgMfaPolicyAction),
    ui: () => <MfaPolicyEditor current="optional" />,
    press: async (user) => {
      await user.click(screen.getByRole('radio', { name: /Required for everyone/ }));
      await user.click(screen.getByRole('button', { name: /Save policy/ }));
    },
    button: /Save policy/,
    sentence: (e) => requestFailedMessage(e, 'save the MFA policy'),
  },
  {
    name: 'Organization Save name',
    action: vi.mocked(renameOrganizationAction),
    ui: () => <OrgNameEditor current="Example Co" />,
    press: async (user) => {
      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'Example Works');
      await user.click(screen.getByRole('button', { name: /Save name/ }));
    },
    button: /Save name/,
    sentence: (e) => requestFailedMessage(e, 'rename the organization'),
  },
  {
    name: 'Organization Save timezone',
    action: vi.mocked(updateOrgTimezoneAction),
    ui: () => <OrgTimezoneEditor current="UTC" />,
    press: async (user) => {
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /New York/ }));
      await user.click(screen.getByRole('button', { name: /Save timezone/ }));
    },
    button: /Save timezone/,
    sentence: (e) => requestFailedMessage(e, 'save the time zone'),
  },
  {
    name: 'Planning Save settings',
    action: vi.mocked(setPlanningParamsAction),
    ui: () => (
      <PlanningParamsPanel
        initial={{ leadTimeDays: 7, safetyMultiplier: 1.5, velocityWindowDays: 30 }}
      />
    ),
    press: (user) => user.click(screen.getByRole('button', { name: /Save settings/ })),
    button: /Save settings/,
    sentence: (e) => requestFailedMessage(e, 'save the planning settings'),
  },
  {
    name: 'PO approval Save',
    action: vi.mocked(setPoApprovalSettingsAction),
    ui: () => <PoApprovalPanel initialAmount={500} />,
    press: (user) => user.click(screen.getByRole('button', { name: /^Save$/ })),
    button: /^Save$/,
    sentence: (e) => requestFailedMessage(e, 'save the approval threshold'),
  },
  {
    name: 'PO terms Save terms',
    action: vi.mocked(updateOrgPoTermsAction),
    ui: () => <PoTermsEditor current={null} />,
    press: async (user) => {
      await user.type(screen.getByLabelText('Terms text'), 'Net 30.');
      await user.click(screen.getByRole('button', { name: /Save terms/ }));
    },
    button: /Save terms/,
    sentence: (e) => requestFailedMessage(e, 'save the purchase order terms'),
  },
  {
    name: 'Profile Save name',
    action: vi.mocked(updateProfileNameAction),
    ui: () => <ProfileNameEditor current="Sam Example" />,
    press: async (user) => {
      await user.clear(screen.getByLabelText('Full name'));
      await user.type(screen.getByLabelText('Full name'), 'Sam Sample');
      await user.click(screen.getByRole('button', { name: /Save name/ }));
    },
    button: /Save name/,
    sentence: (e) => requestFailedMessage(e, 'save your name'),
    // After any failed save the field shows the saved name again (its resync
    // effect runs when busy clears), so Save needs a change to press again.
    again: (user) => user.type(screen.getByLabelText('Full name'), ' Jr'),
  },
  {
    name: 'Recovery Restore',
    action: vi.mocked(restoreDeletedAction),
    ui: () => <RestoreButton entity="categories" id="cat-1" label="Old shelf labels" />,
    press: (user) => user.click(screen.getByRole('button', { name: /Restore/ })),
    button: /Restore/,
    sentence: (e) => requestFailedMessage(e, 'restore "Old shelf labels"'),
  },
  {
    name: 'Zendesk subdomain Save',
    action: vi.mocked(setZendeskSubdomainAction),
    ui: () => <ZendeskQuickAccess subdomain={null} canManage />,
    press: async (user) => {
      await user.type(screen.getByPlaceholderText('yourcompany'), 'example');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    },
    button: 'Save',
    sentence: (e) => requestFailedMessage(e, 'save the Zendesk subdomain'),
  },
  {
    // Sent again, an item already on an open purchase order (a draft
    // included) is skipped, so a draft that was made is not made twice.
    name: 'Reorder report Draft PO from suggestions',
    action: vi.mocked(createDraftPosFromReorderForecastAction),
    ui: () => <DraftPosFromReorderButton itemCount={3} />,
    press: (user) => user.click(screen.getByRole('button', { name: /Draft PO from suggestions/ })),
    button: /Draft PO from suggestions/,
    sentence: (e) => requestFailedMessage(e, 'draft the purchase orders'),
  },
];

/** Lets the rejected call's catch and finally run. */
async function settle(action: Mock) {
  await waitFor(() => expect(action).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
}

describe('settings saves when the request gets no answer', () => {
  for (const c of CASES) {
    it(`${c.name}: says what did not happen, inline too where the panel has a line, and works again`, async () => {
      c.action.mockRejectedValueOnce(offline());
      const user = userEvent.setup();
      render(c.ui());
      await c.press(user);
      const sentence = c.sentence(offline());
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
      if (c.inline) expect(screen.getByRole('alert')).toHaveTextContent(sentence);
      await c.again?.(user);
      expect(screen.getByRole('button', { name: c.button })).toBeEnabled();
      expect(push).not.toHaveBeenCalled();
    });

    it(`${c.name}: a page older than the server says to reload`, async () => {
      c.action.mockRejectedValueOnce(outOfDate());
      const user = userEvent.setup();
      render(c.ui());
      await c.press(user);
      const sentence = c.sentence(outOfDate());
      expect(sentence).toMatch(/^StockPilot was updated since this page was opened/);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    });

    it(`${c.name}: says nothing on the way to sign-in`, async () => {
      c.action.mockRejectedValueOnce(signInRedirect());
      const user = userEvent.setup();
      render(c.ui());
      await c.press(user);
      await settle(c.action);
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.queryByText(/couldn't/i)).toBeNull();
    });
  }
});

describe('the embeddings backfill when a batch gets no answer', () => {
  it('stops, says the backfill did not continue, and can be started again', async () => {
    vi.mocked(backfillItemEmbeddingsAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<EmbeddingsBackfillPanel initialRemaining={120} initialTotal={120} />);
    await user.click(screen.getByRole('button', { name: /Start backfill/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'continue the backfill'),
      ),
    );
    // Not "running" any more: Start is back, and Stop is gone.
    expect(screen.getByRole('button', { name: /Start backfill/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Stop after current batch/ })).toBeNull();
    expect(backfillItemEmbeddingsAction).toHaveBeenCalledTimes(1);
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(backfillItemEmbeddingsAction).mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    render(<EmbeddingsBackfillPanel initialRemaining={120} initialTotal={120} />);
    await user.click(screen.getByRole('button', { name: /Start backfill/ }));
    await settle(vi.mocked(backfillItemEmbeddingsAction));
    expect(toast.error).not.toHaveBeenCalled();
    expect(backfillItemEmbeddingsAction).toHaveBeenCalledTimes(1);
  });
});

describe('Restore from a restore point when the restore gets no answer', () => {
  async function confirmRestore(user: UserEvent) {
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.type(await screen.findByPlaceholderText('RESTORE'), 'RESTORE');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
  }

  beforeEach(() => {
    vi.mocked(restorePointSkuChangesAction).mockResolvedValue({
      ok: true,
      data: { version: 2, changes: [], more: 0, truncated: false },
    } as never);
  });

  // Sent again, the restore sets each item to the point's values measured from
  // what is there now (server/services/restore-points.ts), so a restore that
  // landed applies nothing twice.
  it('says the restore did not happen and Confirm works again', async () => {
    vi.mocked(restoreFromPointAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<RestoreSnapshotButton id="rp-1" when="10/10/2026, 1:00:00 AM" />);
    await confirmRestore(user);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'restore from the restore point'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(restoreFromPointAction).mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    render(<RestoreSnapshotButton id="rp-1" when="10/10/2026, 1:00:00 AM" />);
    await confirmRestore(user);
    await settle(vi.mocked(restoreFromPointAction));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
