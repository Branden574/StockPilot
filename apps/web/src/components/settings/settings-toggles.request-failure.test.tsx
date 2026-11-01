import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS, PERMISSION_META, type CustomFieldDefinition } from '@stockpilot/core';

import { NOTIFICATION_PREF_KEYS, type NotificationPreferences } from '@/lib/notification-prefs';
import {
  isActionOutOfDate,
  requestFailedMessage,
  requestUnconfirmedMessage,
} from '@/lib/request-failure';
import { offline, outOfDate, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: settings that flip at once (the digest, notification switches, module
// switches, permission boxes) or save from a panel with its own error line.
// Each awaited its Server Action with no catch. A call that got no answer
// (offline, a server error, a deploy) left the control busy, kept the flipped
// value as if it had saved, and said nothing; the two that await inside a
// transition (module switches, permission boxes) threw the rejection into
// the settings error page, which replaced the page, and the permission
// box's 'Saving…' toast kept spinning. Now the value goes back, the control
// works again and the failure is said; a redirect to sign-in says nothing.
// ---------------------------------------------------------------------------

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));
vi.mock('@/server/actions/digest', () => ({
  sendDigestPreviewAction: vi.fn(),
  setDigestPrefsAction: vi.fn(),
}));
vi.mock('@/server/actions/notification-preferences', () => ({
  updateNotificationPreferencesAction: vi.fn(),
}));
vi.mock('@/server/actions/email-routing-settings', () => ({
  setOrgEmailRoutingAction: vi.fn(),
}));
vi.mock('@/server/actions/custom-fields', () => ({
  archiveCustomFieldAction: vi.fn(),
  createCustomFieldAction: vi.fn(),
  updateCustomFieldAction: vi.fn(),
}));
vi.mock('@/server/actions/order-status-settings', () => ({
  setOrderStatusConfigAction: vi.fn(),
}));
vi.mock('@/server/actions/order-requests', () => ({
  setPublicRequestBlurbAction: vi.fn(),
  setWarehousePublicOrderableAction: vi.fn(),
}));
vi.mock('@/server/actions/module-settings', () => ({ setModuleEnabledAction: vi.fn() }));
vi.mock('@/server/actions/permissions', () => ({
  setRolePermissionOverrideAction: vi.fn(),
  setUserPermissionOverrideAction: vi.fn(),
  applyAuditorPresetAction: vi.fn(),
}));

import { toast } from 'sonner';

import {
  archiveCustomFieldAction,
  createCustomFieldAction,
  updateCustomFieldAction,
} from '@/server/actions/custom-fields';
import { sendDigestPreviewAction, setDigestPrefsAction } from '@/server/actions/digest';
import { setOrgEmailRoutingAction } from '@/server/actions/email-routing-settings';
import { setModuleEnabledAction } from '@/server/actions/module-settings';
import { updateNotificationPreferencesAction } from '@/server/actions/notification-preferences';
import { setOrderStatusConfigAction } from '@/server/actions/order-status-settings';
import {
  applyAuditorPresetAction,
  setRolePermissionOverrideAction,
  setUserPermissionOverrideAction,
} from '@/server/actions/permissions';
import {
  setPublicRequestBlurbAction,
  setWarehousePublicOrderableAction,
} from '@/server/actions/order-requests';

import { CustomFieldsEditor } from './custom-fields-editor';
import { DigestControls } from './digest-controls';
import { EmailRoutingPanel } from './email-routing-panel';
import { ModuleToggles } from './module-toggles';
import { NotificationPreferencesForm } from './notification-preferences-form';
import { OrderStatusesEditor } from './order-statuses-editor';
import { PublicRequestsGlobalSettings } from './public-requests-global-settings';
import { RolePermissionMatrix } from './role-permission-matrix';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Lets a rejected call's catch and finally run. */
async function settle(call: () => void) {
  await waitFor(call);
  await new Promise((r) => setTimeout(r, 20));
}

/**
 * Stands in for the settings error page: a rejection thrown out of a
 * transition lands here, and the page is replaced by the fallback.
 */
class TestBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p>The settings page broke.</p> : this.props.children;
  }
}

describe('the weekly digest card when a save gets no answer', () => {
  const SECTIONS = { lowStock: true, openPos: true, cycleCounts: true };
  function ui(optIn = true) {
    return (
      <DigestControls
        initialOptIn={optIn}
        initialSections={SECTIONS}
        scheduleLabel="Mondays at 7:00 AM PDT"
      />
    );
  }

  it('the master switch goes back, works again and says so', async () => {
    vi.mocked(setDigestPrefsAction).mockRejectedValueOnce(offline());
    render(ui(true));
    const master = screen.getByRole('switch', { name: 'Toggle weekly digest' });
    fireEvent.click(master);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'unsubscribe you from the weekly digest'),
      ),
    );
    expect(master).toHaveAttribute('aria-checked', 'true');
    expect(master).not.toHaveAttribute('aria-busy');
  });

  it('a section box goes back and says so', async () => {
    vi.mocked(setDigestPrefsAction).mockRejectedValueOnce(offline());
    render(ui(true));
    const box = screen.getByRole('checkbox', { name: /Low \/ out of stock/ });
    fireEvent.click(box);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the digest setting'),
      ),
    );
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(box).toBeEnabled();
  });

  it('Send preview now works again and says the preview was not sent', async () => {
    vi.mocked(sendDigestPreviewAction).mockRejectedValueOnce(offline());
    render(ui(true));
    fireEvent.click(screen.getByRole('button', { name: /Send preview now/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'send the digest preview'),
      ),
    );
    expect(screen.getByRole('button', { name: /Send preview now/ })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(setDigestPrefsAction).mockRejectedValueOnce(signInRedirect());
    render(ui(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle weekly digest' }));
    await settle(() => expect(setDigestPrefsAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('notification switches when a save gets no answer', () => {
  function allOn(): NotificationPreferences {
    return Object.fromEntries(
      NOTIFICATION_PREF_KEYS.map((k) => [k, true]),
    ) as NotificationPreferences;
  }

  it('the switch goes back, is no longer busy, and says so', async () => {
    vi.mocked(updateNotificationPreferencesAction).mockRejectedValueOnce(offline());
    render(<NotificationPreferencesForm initial={allOn()} />);
    const sw = screen.getByRole('switch', { name: 'Toggle Maintenance request resolved' });
    fireEvent.click(sw);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the notification setting'),
      ),
    );
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).not.toHaveAttribute('aria-busy');
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(updateNotificationPreferencesAction).mockRejectedValueOnce(signInRedirect());
    render(<NotificationPreferencesForm initial={allOn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Maintenance request resolved' }));
    await settle(() => expect(updateNotificationPreferencesAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('email routing when a save gets no answer', () => {
  const UNSET = { state: 'unset' } as const;
  const SET = {
    state: 'valid',
    recipients: {
      to: 'intake@example.com',
      cc: 'copy@example.com',
    },
  } as const;

  it('Save routing says so in the card and works again', async () => {
    vi.mocked(setOrgEmailRoutingAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<EmailRoutingPanel initialDelivery={UNSET} initialMaintenance={UNSET} />);
    await user.type(
      screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }),
      'intake@example.com',
    );
    await user.type(
      screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }),
      'copy@example.com',
    );
    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[0]!);
    const sentence = requestFailedMessage(offline(), 'save the email routing');
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    expect(screen.getAllByRole('button', { name: 'Save routing' })[0]!).toBeEnabled();
  });

  it('Confirm clear stays up, says so and can be pressed again', async () => {
    vi.mocked(setOrgEmailRoutingAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<EmailRoutingPanel initialDelivery={SET} initialMaintenance={UNSET} />);
    await user.click(screen.getByRole('button', { name: 'Clear routing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm clear' }));
    const sentence = requestFailedMessage(offline(), 'clear the email routing');
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(screen.getByRole('button', { name: 'Confirm clear' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(setOrgEmailRoutingAction).mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    render(<EmailRoutingPanel initialDelivery={SET} initialMaintenance={UNSET} />);
    await user.click(screen.getByRole('button', { name: 'Clear routing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm clear' }));
    await settle(() => expect(setOrgEmailRoutingAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('custom fields when a save gets no answer', () => {
  function def(id: string, label: string, sortOrder: number): CustomFieldDefinition {
    return {
      id,
      organizationId: 'org-1',
      entity: 'item',
      fieldKey: label.toLowerCase().replace(/\W+/g, '_'),
      label,
      fieldType: 'text',
      options: null,
      required: false,
      sortOrder,
      archived: false,
    };
  }

  // Sent again, a create that landed is refused by the field key's unique
  // rule (custom_field_definitions unique (organization_id, entity,
  // field_key)), so the failed sentence is safe.
  it('Add field keeps the draft, says the field was not added and works again', async () => {
    vi.mocked(createCustomFieldAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<CustomFieldsEditor initialDefinitions={[]} />);
    await user.click(screen.getByRole('button', { name: /Add field/ }));
    await user.type(screen.getByLabelText('Label'), 'Warranty');
    await user.type(screen.getByLabelText('Field key'), 'warranty');
    const add = screen.getAllByRole('button', { name: /Add field/ }).at(-1)!;
    await user.click(add);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'add the field')),
    );
    expect(screen.getByLabelText('Label')).toHaveValue('Warranty');
    expect(screen.getAllByRole('button', { name: /Add field/ }).at(-1)!).toBeEnabled();
  });

  it('Archive field says the field was not archived and leaves it in the list', async () => {
    vi.mocked(archiveCustomFieldAction).mockRejectedValueOnce(offline());
    render(<CustomFieldsEditor initialDefinitions={[def('a', 'Warranty', 0)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive field' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'archive the field'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Archive field' })).toBeEnabled();
  });

  it('a move sends two writes and one may land: it keeps the order and says to reload before trying again', async () => {
    vi.mocked(updateCustomFieldAction)
      .mockResolvedValueOnce({ ok: true, data: { definition: def('b', 'Voltage', 0) } } as never)
      .mockRejectedValueOnce(offline());
    render(
      <CustomFieldsEditor initialDefinitions={[def('a', 'Warranty', 0), def('b', 'Voltage', 1)]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Voltage up' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "We couldn't confirm that the fields were reordered. Reload the page to see their order before trying again.",
      ),
    );
    // The order on the page is the one it had: nothing was applied.
    const edits = screen.getAllByRole('button', { name: /^Edit / });
    expect(edits.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Edit Warranty',
      'Edit Voltage',
    ]);
    expect(screen.getByRole('button', { name: 'Move Voltage up' })).toBeEnabled();
  });

  it('a move from a page older than the server says nothing was changed', async () => {
    vi.mocked(updateCustomFieldAction).mockRejectedValue(outOfDate());
    render(
      <CustomFieldsEditor initialDefinitions={[def('a', 'Warranty', 0), def('b', 'Voltage', 1)]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Voltage up' }));
    expect(isActionOutOfDate(outOfDate())).toBe(true);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(outOfDate(), 'the fields were reordered', 'their order'),
      ),
    );
    vi.mocked(updateCustomFieldAction).mockReset();
  });
});

describe('order status labels when a save gets no answer', () => {
  it('Save changes says the labels were not saved and works again', async () => {
    vi.mocked(setOrderStatusConfigAction).mockRejectedValueOnce(offline());
    render(<OrderStatusesEditor initialConfig={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the status labels'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('Reset all to defaults says the statuses were not reset and works again', async () => {
    vi.mocked(setOrderStatusConfigAction).mockRejectedValueOnce(offline());
    render(<OrderStatusesEditor initialConfig={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'reset the statuses'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Reset all to defaults' })).toBeEnabled();
  });
});

describe('public request settings when a save gets no answer', () => {
  const WAREHOUSES = [{ id: 'wh-1', name: 'Main DC', isPublicOrderable: false }];

  // Real timers: the autosave waits 800 ms after typing (pattern 31).
  it('the blurb autosave says so under the box, once, and stops saying Saving…', async () => {
    vi.mocked(setPublicRequestBlurbAction).mockRejectedValueOnce(offline());
    render(<PublicRequestsGlobalSettings initialBlurb={null} warehouses={WAREHOUSES} />);
    fireEvent.change(
      screen.getByPlaceholderText('Tell visitors who you are and how requests are fulfilled.'),
      { target: { value: 'Hello' } },
    );
    const sentence = requestFailedMessage(offline(), 'save the public blurb');
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence, { id: 'public-blurb-save' });
    expect(screen.queryByText('Saving…')).toBeNull();
  });

  it('a warehouse switch says so, keeps its state and works again', async () => {
    vi.mocked(setWarehousePublicOrderableAction).mockRejectedValueOnce(offline());
    render(<PublicRequestsGlobalSettings initialBlurb={null} warehouses={WAREHOUSES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
    const sentence = requestFailedMessage(offline(), 'let the warehouse take public requests');
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(screen.getByRole('button', { name: 'Closed' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(setWarehousePublicOrderableAction).mockRejectedValueOnce(signInRedirect());
    render(<PublicRequestsGlobalSettings initialBlurb={null} warehouses={WAREHOUSES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
    await settle(() => expect(setWarehousePublicOrderableAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('module switches when the save gets no answer (inside a transition)', () => {
  const modules = [
    { id: 'inventory' as const, title: 'Inventory', tier: 'core' as const },
    { id: 'rentals' as const, title: 'Rentals', tier: 'optional' as const },
  ];

  it('keeps the settings page, puts the switch back and says so', async () => {
    vi.mocked(setModuleEnabledAction).mockRejectedValueOnce(offline());
    render(
      <TestBoundary>
        <ModuleToggles modules={modules} enabledIds={['rentals']} />
      </TestBoundary>,
    );
    const rentals = screen.getByRole('switch', { name: 'Toggle Rentals' });
    fireEvent.click(rentals);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'turn off Rentals')),
    );
    expect(screen.queryByText('The settings page broke.')).toBeNull();
    const again = screen.getByRole('switch', { name: 'Toggle Rentals' });
    expect(again).toHaveAttribute('aria-checked', 'true');
    expect(again).toBeEnabled();
    expect(again).not.toHaveAttribute('aria-busy');
  });

  it('says nothing on the way to sign-in, and keeps the page', async () => {
    vi.mocked(setModuleEnabledAction).mockRejectedValueOnce(signInRedirect());
    render(
      <TestBoundary>
        <ModuleToggles modules={modules} enabledIds={['rentals']} />
      </TestBoundary>,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Rentals' }));
    await settle(() => expect(setModuleEnabledAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText('The settings page broke.')).toBeNull();
  });
});

describe('permission boxes when the save gets no answer (inside a transition)', () => {
  const FIRST = PERMISSIONS[0]!;
  const label = (who: string) => `${who} — ${PERMISSION_META[FIRST].label}`;
  const SAVE_TOAST = { id: 'perm-save' };

  it('a role box: keeps the page, goes back, is no longer busy, and the error replaces Saving…', async () => {
    vi.mocked(setRolePermissionOverrideAction).mockRejectedValueOnce(offline());
    render(
      <TestBoundary>
        <RolePermissionMatrix roleOverrides={[]} userOverrides={[]} members={[]} />
      </TestBoundary>,
    );
    const box = screen.getByRole('checkbox', { name: label('Viewer') });
    const before = box.getAttribute('aria-checked');
    fireEvent.click(box);
    expect(toast.loading).toHaveBeenCalledWith('Saving…', SAVE_TOAST);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the permission'),
        SAVE_TOAST,
      ),
    );
    expect(screen.queryByText('The settings page broke.')).toBeNull();
    const again = screen.getByRole('checkbox', { name: label('Viewer') });
    expect(again).toHaveAttribute('aria-checked', before);
    expect(screen.queryByLabelText(`Saving ${label('Viewer')}`)).toBeNull();
  });

  it("a member's box: the same", async () => {
    vi.mocked(setUserPermissionOverrideAction).mockRejectedValueOnce(offline());
    render(
      <TestBoundary>
        <RolePermissionMatrix
          roleOverrides={[]}
          userOverrides={[]}
          members={[{ userId: 'u-2', name: 'Sam', role: 'staff' }]}
        />
      </TestBoundary>,
    );
    const region = screen.getByRole('region', { name: 'Permissions for Sam' });
    const box = within(region).getAllByRole('checkbox')[0]!;
    const before = box.getAttribute('aria-checked');
    fireEvent.click(box);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the permission'),
        SAVE_TOAST,
      ),
    );
    expect(screen.queryByText('The settings page broke.')).toBeNull();
    expect(within(region).getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', before);
  });

  it('the Auditor preset: keeps the page and the error replaces its loading toast', async () => {
    vi.mocked(applyAuditorPresetAction).mockRejectedValueOnce(offline());
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    render(
      <TestBoundary>
        <RolePermissionMatrix roleOverrides={[]} userOverrides={[]} members={[]} />
      </TestBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Auditor preset/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'apply the Auditor preset'),
        SAVE_TOAST,
      ),
    );
    expect(screen.queryByText('The settings page broke.')).toBeNull();
    expect(screen.getByRole('button', { name: /Auditor preset/ })).toBeEnabled();
    vi.unstubAllGlobals();
  });

  it('on the way to sign-in: no error, and the Saving… toast is taken away', async () => {
    vi.mocked(setRolePermissionOverrideAction).mockRejectedValueOnce(signInRedirect());
    render(
      <TestBoundary>
        <RolePermissionMatrix roleOverrides={[]} userOverrides={[]} members={[]} />
      </TestBoundary>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: label('Viewer') }));
    await settle(() => expect(setRolePermissionOverrideAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith('perm-save');
    expect(screen.queryByText('The settings page broke.')).toBeNull();
  });
});
