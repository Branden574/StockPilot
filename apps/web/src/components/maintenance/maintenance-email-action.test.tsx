import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Rest param on the mock itself (not the brief's literal zero-arg
// `() => {...}`) — same reason the delivery precedent's
// `recordDraftedSpy` takes one (delivery-request-action.test.tsx:20-23):
// `recordMaintenanceDraftOpenedAction(...args)` below spreads an
// `unknown[]`, and TS2556 rejects spreading a non-tuple array into a
// zero-parameter function signature. A rest param accepts the spread
// directly while keeping the exact same return behavior.
const recordAction = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, openCount: 1 }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  recordMaintenanceDraftOpenedAction: (...args: unknown[]) => recordAction(...args),
}));

// Minor 10: the .catch() added for IMPORTANT 1 reports a breadcrumb via
// reportError rather than letting a lost draft-opened row go completely
// unobserved. Mocked (not the real webhook/console implementation) so the
// rejection tests below can assert the breadcrumb actually fires, not just
// that the rejection was swallowed.
const reportErrorMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

import { MaintenanceEmailAction } from './maintenance-email-action';
import {
  DRAFT_URL_LIMIT,
  L4L_MAINTENANCE_RECIPIENTS,
  prepareMaintenanceEmail,
  type MaintenanceEmailContent,
  type MaintenanceEmailInput,
} from '@stockpilot/core';

/** The routing DTO every render below hands the component — the compiled
 *  pair (what the server resolves for L4L, whose seed preserves today's
 *  values), so every existing pin stays on pre-feature behavior. */
const TEST_ROUTING = {
  to: L4L_MAINTENANCE_RECIPIENTS.to,
  cc: L4L_MAINTENANCE_RECIPIENTS.cc,
  toName: L4L_MAINTENANCE_RECIPIENTS.toName,
  ccName: L4L_MAINTENANCE_RECIPIENTS.ccName,
};

const INPUT: MaintenanceEmailContent = {
  requestNumber: 'MR-2026-000123',
  subject: 'AC broken in Room 204',
  description: 'Warm air only.',
  category: null,
  priority: 'high',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: null,
  requesterPhone: null,
  siteName: 'Fresno Learning Center',
  department: null,
  building: null,
  roomOrArea: null,
  accessInstructions: null,
  relatedItem: null,
  relatedOrder: null,
  relatedRental: null,
  photoCount: 0,
  shareUrl: null,
};

/**
 * A maximally-detailed request (every optional field populated at once),
 * matching the master brief's own §15 worked example verbatim. Confirmed in
 * packages/core/src/maintenance/email.test.ts ("measured reality" describe
 * block) to produce `draft.condensed === true` while `linkFits` stays
 * `true` — the CONDENSED-BUT-FITS state the condensed-notice tests below
 * need. Copied here rather than imported: the fixture is a private const in
 * that test file, not an exported one.
 */
const CONDENSED_BUT_FITS_INPUT: MaintenanceEmailContent = {
  requestNumber: 'MR-2026-000123',
  subject: 'Air conditioner is not working in Room 204',
  description:
    'The air conditioner has been blowing warm air since yesterday afternoon.\nThe room is becoming too warm for normal use.',
  category: 'Heating or air conditioning',
  priority: 'high',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: 'jane.smith@learn4life.org',
  requesterPhone: '(555) 555-0199',
  siteName: 'Fresno Learning Center',
  department: 'Operations',
  building: 'Main Building',
  roomOrArea: 'Room 204',
  accessInstructions: 'Please contact the main office before entering the room.',
  relatedItem: {
    name: 'Wall-mounted HVAC unit',
    sku: 'HVAC-WALL-204',
    barcode: '012345678905',
    modelNumber: 'ACX-9000',
    warehouseName: 'Fresno Distribution Center',
    locationName: 'Room 204 Closet',
    url: 'https://stockpilotusa.com/dashboard/inventory/11111111-1111-1111-1111-111111111111',
  },
  relatedOrder: null,
  relatedRental: null,
  photoCount: 3,
  shareUrl: 'https://stockpilotusa.com/m/abcdef1234567890',
};

let openSpy: ReturnType<typeof vi.fn>;
let originalOpen: PropertyDescriptor | undefined;
let originalClipboard: PropertyDescriptor | undefined;
let assignSpy: ReturnType<typeof vi.fn>;
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalOpen = Object.getOwnPropertyDescriptor(window, 'open');
  openSpy = vi.fn(() => ({ opener: {} }) as unknown as Window);
  Object.defineProperty(window, 'open', { value: openSpy, configurable: true, writable: true });
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
  assignSpy = vi.fn();
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign: assignSpy },
    configurable: true,
  });
});

afterEach(() => {
  if (originalOpen) Object.defineProperty(window, 'open', originalOpen);
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
});

function renderAction(overrides: Partial<Parameters<typeof MaintenanceEmailAction>[0]> = {}) {
  return render(
    <MaintenanceEmailAction
      requestId="r1"
      emailInput={INPUT}
      recipients={TEST_ROUTING}
      initialOpenCount={0}
      {...overrides}
    />,
  );
}

describe('WEB DEFAULT PIN: the no-options prepare this component performs is fitted against the WEB url it opens', () => {
  // This component calls `prepareMaintenanceEmail(emailInput)` with no
  // transport option and opens `outlookUrl` (window.open below). Since
  // 2026-08-16 the core builder also accepts `transport: 'outlook-native'`
  // for the phone; the DEFAULT must remain 'outlook-web', because that is
  // the url THIS surface hands to the browser. The fixture's full draft
  // measures over DRAFT_URL_LIMIT on the web url but under it on the native
  // url — so if the default ever flips, the prepared draft stops condensing,
  // linkFits stays true, and the url this component would open exceeds the
  // limit: both assertions below fail, naming the silent truncation that
  // flip would ship.
  const LONG_DESCRIPTION_CONTENT: MaintenanceEmailContent = {
    ...CONDENSED_BUT_FITS_INPUT,
    requestNumber: 'MR-2026-000456',
    subject: 'Hallway heater grinding and overheating near Room 118',
    description: [
      'The heating unit in the main hallway outside Room 118 has been making a loud grinding noise since Monday morning.',
      'It runs for about ten minutes, shuts off with a bang, and then restarts on its own a few minutes later.',
      'The thermostat on the wall reads 81 degrees even though it is set to 72, and the air coming out of the vent is cold.',
      'Two staff members have reported headaches from the noise, and the afternoon study group has been moved to the library as a result.',
    ].join(' '),
    accessInstructions: null,
    relatedItem: null,
    photoCount: 0,
    shareUrl: null,
  };

  // The full input the component assembles at its seam: content plus the
  // branded recipients built from the routing DTO it was handed.
  const LONG_DESCRIPTION_INPUT: MaintenanceEmailInput = {
    ...LONG_DESCRIPTION_CONTENT,
    recipients: L4L_MAINTENANCE_RECIPIENTS,
  };

  it('an undeclared transport is fitted against the web url this component opens, and stays within the limit', () => {
    const prepared = prepareMaintenanceEmail(LONG_DESCRIPTION_INPUT);
    expect(prepared.transport).toBe('outlook-web');
    expect(prepared.linkFits).toBe(true);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
  });

  it('the component really opens the url the default measured (window.open receives outlookUrl)', async () => {
    const prepared = prepareMaintenanceEmail(LONG_DESCRIPTION_INPUT);
    renderAction({ emailInput: LONG_DESCRIPTION_CONTENT });
    await userEvent.click(screen.getByRole('button', { name: /open in outlook/i }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]![0]).toBe(prepared.outlookUrl);
  });
});

describe('Open in Outlook (component tests 7, 14)', () => {
  it('opens the compose URL with NO features string and severs the opener', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0]!;
    expect(String(url)).toContain('outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=');
    expect(String(url)).toContain(encodeURIComponent(encodeURIComponent('dc4@learn4life.org')));
    expect(target).toBe('_blank');
    expect(features).toBeUndefined(); // 'noopener' would return null even on success
    const handle = openSpy.mock.results[0]!.value as { opener: unknown };
    expect(handle.opener).toBeNull();
  });

  it('R3 ordering: the record action fires AFTER the open, never before', async () => {
    const order: string[] = [];
    openSpy.mockImplementation(() => {
      order.push('open');
      return { opener: {} } as unknown as Window;
    });
    recordAction.mockImplementation(async () => {
      order.push('record');
      return { ok: true as const, openCount: 1 };
    });
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await waitFor(() => expect(order).toEqual(['open', 'record']));
    // Minor 4: pin the argument on the success-path call site too (not just
    // the blocked-path one below) — a hardcoded foreign UUID here would
    // still satisfy the ordering assertion above.
    expect(recordAction).toHaveBeenCalledWith('r1');
  });

  it('shows the exact accurate-status success message in an aria-live region', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    const msg =
      'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByText(msg).closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
  });

  it('makes NO network call on the open click (fetch spy)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(fetchSpy).not.toHaveBeenCalled(); // record goes through the mocked action, not fetch
    vi.unstubAllGlobals();
  });
});

describe('IMPORTANT 1 fix: recordMaintenanceDraftOpenedAction rejection is absorbed, never an unhandled rejection', () => {
  // Precedent: delivery-request-action.test.tsx's "still opens the draft
  // when the audit call rejects" (delivery-request-action.tsx:141-148's
  // `.catch()`). recordAction here is fire-and-forget (`void ...`, never
  // awaited by the click handler), so a REJECTED promise — not a resolved
  // `{ error }`, an actual network failure — has nowhere to land except a
  // process-level 'unhandledRejection' unless production code attaches its
  // own `.catch()`. This listener is the only thing in these tests that
  // observes that.
  it('success path (call site after window.open succeeds): success message still renders, no unhandled rejection', async () => {
    recordAction.mockRejectedValueOnce(new Error('offline'));
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    const msg =
      'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';
    expect(await screen.findByText(msg)).toBeInTheDocument();

    // Flush microtasks so a same-tick 'unhandledRejection' has a chance to
    // fire before we assert on `unhandled`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', onUnhandledRejection);
    expect(unhandled).toEqual([]);
    // Minor 10: the rejection is still observable via the breadcrumb.
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'maintenance.draft-opened.record' }),
    );
  });

  it('blocked path (mailto fallback call site): recovery panel still renders, no unhandled rejection', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    recordAction.mockRejectedValueOnce(new Error('offline'));
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(await screen.findByText('Outlook could not be opened automatically.')).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', onUnhandledRejection);
    expect(unhandled).toEqual([]);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'maintenance.draft-opened.record' }),
    );
  });
});

describe('duplicate-draft protection (component test 11; brief section 21)', () => {
  it('second open shows the warning dialog with Cancel / Open Another Draft', async () => {
    renderAction({ initialOpenCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(openSpy).not.toHaveBeenCalled(); // dialog first, open only on confirm
    expect(
      screen.getByText(
        'A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Another Draft' }));
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
  it('Cancel closes without opening anything', async () => {
    renderAction({ initialOpenCount: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(openSpy).not.toHaveBeenCalled();
  });
  it('renders a SECOND aria-live region INSIDE the duplicate-draft dialog (Radix aria-hides outside content — landmine 10)', async () => {
    renderAction({ initialOpenCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    const dialog = await screen.findByRole('dialog');
    // Plain DOM query, not getByText: the live region's accessible content
    // is what matters here, not its (currently empty) text — Radix's modal
    // mode aria-hides every sibling of the portalled dialog while it is
    // open, so the PAGE-LEVEL live region rendered outside DialogContent is
    // invisible to assistive tech at this moment. A second, dialog-scoped
    // region is the only one a screen reader can hear from in this state.
    const liveRegions = within(dialog).getByTestId('maintenance-email-live-dialog');
    expect(liveRegions).toHaveAttribute('aria-live', 'polite');
    expect(liveRegions).toHaveAttribute('aria-atomic', 'true');
  });
});

describe('popup blocked (component test 8; brief section 19)', () => {
  it('falls back: message, mailto once, all four recovery actions, still records ONE draft', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(await screen.findByText('Outlook could not be opened automatically.')).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(String(assignSpy.mock.calls[0]![0])).toMatch(/^mailto:dc4@learn4life\.org\?cc=arosas%40cvwest\.org/);
    for (const label of ['Try Outlook Again', 'Open in Default Email App', 'Copy Email Details']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(recordAction).toHaveBeenCalledTimes(1);
    // Minor 4: the count alone lets a hardcoded foreign UUID survive —
    // pin the ARGUMENT too, so recording under the wrong request id fails.
    expect(recordAction).toHaveBeenCalledWith('r1');
    // Second blocked click: no second mailto navigation, no second record.
    await userEvent.click(screen.getByRole('button', { name: 'Try Outlook Again' }));
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledTimes(1);
  });
  it('never shows the success message when blocked', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(screen.queryByText(/Outlook opened with your maintenance request/)).toBeNull();
  });
});

describe('oversized draft (linkFits false)', () => {
  it('opens NOTHING — not even mailto — and presents the clipboard path', async () => {
    renderAction({ emailInput: { ...INPUT, requesterName: 'X'.repeat(3000) } });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/too long for an email link/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Email Details' })).toBeInTheDocument();
  });

  it('mutation self-check: never offers "Open in Default Email App" (or any other mailto trigger) when linkFits is false', () => {
    // linkFits:false means the mailto: URL is ALSO oversized (condensing
    // does not shorten a pathological requester name — see email.ts's own
    // module doc). Offering a manual mailto button here would silently
    // truncate the body exactly like the auto-navigation this state
    // deliberately skips.
    renderAction({ emailInput: { ...INPUT, requesterName: 'X'.repeat(3000) } });
    expect(screen.queryByRole('button', { name: 'Open in Default Email App' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open in Default Email App' })).toBeNull();
  });
});

describe('copy fallback (component test 9; brief section 18)', () => {
  it('copies the labelled blocks and toasts the exact instruction', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0] as string;
    expect(written).toContain('TO: dc4@learn4life.org');
    expect(written).toContain('CC: arosas@cvwest.org');
    expect(
      await screen.findByText(
        'Maintenance request copied. Create a new email to dc4@learn4life.org, CC arosas@cvwest.org, and paste the copied details.',
      ),
    ).toBeInTheDocument();
  });
  it('clipboard failure reveals a selectable textarea with the full content', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    const area = await screen.findByRole('textbox');
    expect(area).toHaveAttribute('readonly');
    expect((area as HTMLTextAreaElement).value).toContain('TO: dc4@learn4life.org');
  });
  it('Minor 5: copies the FULL body even when the open-link draft is condensed (mutation self-check: rebuilding clipboard from prepared.draft.body must fail this)', async () => {
    // CONDENSED_BUT_FITS_INPUT drives prepared.draft.condensed === true, so
    // prepared.draft.body has dropped access instructions, department,
    // email/phone, category/priority/submitted, and the reply-thread
    // sentence (email.ts's condense preserve-list). prepared.clipboardText
    // is built from prepareMaintenanceEmail's separately-tracked FULL draft
    // (email.ts:355-358) — it has no URL-length limit and must always carry
    // everything, condensed or not. Access instructions is on the
    // condense-drop list, so its presence here proves the clipboard did NOT
    // come from the condensed draft.body.
    renderAction({ emailInput: CONDENSED_BUT_FITS_INPUT });
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0] as string;
    expect(written).toContain('Please contact the main office before entering the room.');
  });
});

describe('condensed-state disclosure (Task 7 review finding — mutation self-check: suppress it and this fails)', () => {
  it('surfaces a prominent notice when the emailed body is condensed but still fits a link', () => {
    renderAction({ emailInput: CONDENSED_BUT_FITS_INPUT });
    expect(screen.getByText(/shortened|condensed|summary/i)).toBeInTheDocument();
    // Must point the user at BOTH honest recovery paths: the saved request
    // and the clipboard copy — never silently drop the rest of the text.
    const notice = screen.getByText(/shortened|condensed|summary/i);
    expect(notice.textContent).toMatch(/saved/i);
    expect(notice.textContent?.toLowerCase()).toContain('copy email details');
  });
  it('shows no condensed disclosure for a normal, non-condensed request', () => {
    renderAction();
    expect(screen.queryByText(/shortened|condensed/i)).toBeNull();
  });
});

describe('honesty sweep (component test 14; brief section 20)', () => {
  // IMPORTANT 2 fix: the original sweep only ever asserted against
  // `container.textContent` — the render-target DOM node returned by RTL's
  // `render()`. Radix Dialog PORTALS its content to a node appended directly
  // under `document.body`, entirely outside `container`, so any copy that
  // only appears inside the confirm dialog was structurally unsweepable:
  // a literal "Email sent to DC4." planted in DialogDescription (or any
  // dialog-only node) would pass every one of the assertions below with the
  // old `container`-scoped check. Sweeping `document.body.textContent`
  // instead covers the portal too, and still covers everything `container`
  // did (container is itself inside body). Every state the component can be
  // in is driven and swept: success, blocked, oversized (linkFits false),
  // condensed-but-fits, and the duplicate-draft dialog open.
  const BANNED_PHRASES = [
    'Ticket created',
    'Request submitted to Zendesk',
    'DC4 notified',
    'Andrew notified',
    'Ticket assigned',
    'Email sent',
  ];

  function assertHonestBody() {
    for (const banned of BANNED_PHRASES) {
      expect(document.body.textContent).not.toContain(banned);
    }
  }

  it('success state: no forbidden phrase after a successful open', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await screen.findByText(/Outlook opened with your maintenance request/);
    assertHonestBody();
  });

  it('blocked state: no forbidden phrase in the recovery panel', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await screen.findByText('Outlook could not be opened automatically.');
    assertHonestBody();
  });

  it('oversized state (linkFits false): no forbidden phrase', async () => {
    renderAction({ emailInput: { ...INPUT, requesterName: 'X'.repeat(3000) } });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await screen.findByText(/too long for an email link/i);
    assertHonestBody();
  });

  it('condensed-but-fits state: no forbidden phrase', () => {
    renderAction({ emailInput: CONDENSED_BUT_FITS_INPUT });
    assertHonestBody();
  });

  it('dialog-open state: no forbidden phrase INSIDE the Radix portal (the state the old container-scoped sweep could not reach)', async () => {
    renderAction({ initialOpenCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await screen.findByRole('dialog');
    assertHonestBody();
  });
});

describe('photo-driven behavior (photo test 11; component test 10)', () => {
  it('removing a photo updates the email content (photoCount 3 -> 0 drops the PHOTOS section)', async () => {
    const { rerender } = renderAction({
      emailInput: { ...INPUT, photoCount: 3, shareUrl: 'https://stockpilotusa.com/m/tok' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0] as string).toContain(
      '3 photos were uploaded',
    );
    rerender(
      <MaintenanceEmailAction
        requestId="r1"
        emailInput={{ ...INPUT, photoCount: 0, shareUrl: null }}
        recipients={TEST_ROUTING}
        initialOpenCount={0}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]![0] as string).not.toContain(
      'photos were uploaded',
    );
  });

  it('the blocked panel offers Download Photos for Outlook when photos exist', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction({
      emailInput: { ...INPUT, photoCount: 2, shareUrl: 'https://stockpilotusa.com/m/tok' },
      photoDownloads: [
        { url: 'https://files.example.test/a.jpg', filename: 'a.jpg' },
        { url: 'https://files.example.test/b.jpg', filename: 'b.jpg' },
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(await screen.findByText('Outlook could not be opened automatically.')).toBeInTheDocument();
    expect(screen.getByText('Download Photos for Outlook')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'a.jpg' })).toHaveAttribute('download');
  });

  it('does not render a Download Photos group when no photoDownloads are supplied', () => {
    renderAction();
    expect(screen.queryByText('Download Photos for Outlook')).toBeNull();
  });
});
