import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ── next/navigation: notFound must THROW (never render), useRouter is what
// every nested client component (AssignOwnerSelect, ShareLinkPanel,
// MaintenanceNotesPanel, detail-client's wrappers) calls on mount. ──────────
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ── module gate, mirroring the list page's own test idiom ──────────────────
const moduleAccess = vi.hoisted(() => ({ current: { enabled: true, canManage: false } }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => moduleAccess.current),
}));
const moduleNotEnabledProps = vi.fn();
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: (props: Record<string, unknown>) => {
    moduleNotEnabledProps(props);
    return <div data-testid="module-not-enabled" />;
  },
}));

// ── ServiceError must be a REAL-shaped class (code + message) so the page's
// `e instanceof ServiceError` / `e.code === 'not_found'` checks work exactly
// as they do in production — same idiom as po-detail-destination.test.tsx /
// auditor-read-gates.test.tsx. withContext is the seam every persona test
// configures per-case. ──────────────────────────────────────────────────────
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ServiceError';
    }
  },
  withContext: vi.fn(),
}));

const get = vi.fn();
const listNotes = vi.fn();
const emailInput = vi.fn();
const listTimelineEvents = vi.fn();
vi.mock('@/server/services/maintenance-requests', () => ({ MaintenanceRequestsService: vi.fn() }));

const signedViewUrls = vi.fn();
vi.mock('@/server/services/maintenance-attachments', () => ({ MaintenanceAttachmentsService: vi.fn() }));

const ensureActiveLink = vi.fn();
// Only the CLASS is mocked (ensureActiveLink is wired per-test below) —
// maintenanceShareLinksEnabled stays the REAL implementation, which reads
// `ctx.supabase`'s own 'organization_modules.select' canning, the exact
// org-setting read this page used to duplicate locally before Task 4 lifted
// it into this shared module.
vi.mock('@/server/services/maintenance-share-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/maintenance-share-links')>();
  return { ...actual, MaintenanceShareLinksService: vi.fn() };
});

// Every server action any nested client component might call — none of
// these fire on a plain render, but importing the REAL module would pull in
// `server-only`-guarded services under happy-dom (same reason
// maintenance-review.test.tsx mocks recordMaintenanceDraftOpenedAction).
vi.mock('@/server/actions/maintenance-requests', () => ({
  createMaintenanceRequestAction: vi.fn(async () => ({ ok: true })),
  updateMaintenanceRequestAction: vi.fn(async () => ({ ok: true })),
  archiveMaintenanceRequestAction: vi.fn(async () => ({ ok: true })),
  cancelMaintenanceRequestAction: vi.fn(async () => ({ ok: true })),
  assignMaintenanceOwnerAction: vi.fn(async () => ({ ok: true })),
  addMaintenanceNoteAction: vi.fn(async () => ({ ok: true, id: 'note-1' })),
  recordMaintenanceDraftOpenedAction: vi.fn(async () => ({ ok: true, openCount: 0 })),
  revokeMaintenanceShareLinkAction: vi.fn(async () => ({ ok: true })),
}));

import { ServiceError, withContext } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceShareLinksService } from '@/server/services/maintenance-share-links';
import { checkModuleAccess } from '@/lib/modules/module-gate';

import MaintenanceRequestDetailPage from './page';

const VALID_ID = '11111111-1111-1111-1111-111111111111';
const BAD_ID = 'not-a-uuid';

/** Every field of the REAL MaintenanceRequestDetail interface, matching
 *  maintenance-review.test.tsx's own fixture convention — a future
 *  rename/removal breaks this fixture, not just an inference. */
function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID,
    requestNumber: 42,
    createdAt: '2026-08-01T12:00:00.000Z',
    subject: 'AC not working in Room 204',
    status: 'saved',
    priority: 'high',
    category: 'Heating or air conditioning',
    siteName: 'Fresno Warehouse DC4',
    requesterName: 'Jane Smith',
    requesterUserId: 'other-user',
    photoCount: 0,
    draftOpened: false,
    localOwnerUserId: null,
    description: 'Warm air only.',
    requesterEmail: 'jane@example.com',
    requesterPhone: null,
    charterId: null,
    warehouseId: null,
    building: null,
    roomOrArea: null,
    department: null,
    accessInstructions: null,
    relatedItemId: null,
    relatedOrderRequestId: null,
    relatedRentalId: null,
    relatedLocationId: null,
    outlookDraftOpenedAt: null,
    outlookDraftOpenCount: 0,
    archivedAt: null,
    cancelledAt: null,
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function buildCtx(opts: { userId?: string; permissions?: string[]; membersData?: unknown[] } = {}) {
  const stub = makeSupabaseStub({
    'organization_modules.select': { data: { settings: {} }, error: null },
    'organization_members.select': { data: opts.membersData ?? [], error: null },
  });
  return makeServiceContext(stub.client, {
    userId: opts.userId ?? 'u-1',
    permissions: new Set(opts.permissions ?? []),
  });
}

function args(searchParams: Record<string, string> = {}) {
  return { params: Promise.resolve({ id: VALID_ID }), searchParams: Promise.resolve(searchParams) };
}

beforeEach(() => {
  vi.clearAllMocks();
  moduleAccess.current = { enabled: true, canManage: false };
  get.mockReset();
  listNotes.mockReset();
  emailInput.mockReset();
  signedViewUrls.mockReset();
  ensureActiveLink.mockReset();
  listTimelineEvents.mockReset();

  get.mockResolvedValue(detailFixture());
  listNotes.mockResolvedValue([]);
  signedViewUrls.mockResolvedValue([]);
  listTimelineEvents.mockResolvedValue([]);
  emailInput.mockImplementation(async (_id: string, opts: { shareUrl: string | null }) => ({
    requestNumber: 'MR-2026-000042',
    subject: 'AC not working in Room 204',
    description: 'Warm air only.',
    category: 'Heating or air conditioning',
    priority: 'high',
    submittedAtDisplay: 'Aug 1, 2026',
    requesterName: 'Jane Smith',
    requesterEmail: 'jane@example.com',
    requesterPhone: null,
    siteName: 'Fresno Warehouse DC4',
    department: null,
    building: null,
    roomOrArea: null,
    accessInstructions: null,
    relatedItem: null,
    relatedOrder: null,
    relatedRental: null,
    photoCount: 0,
    shareUrl: opts.shareUrl,
  }));

  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () =>
      ({ get, listNotes, emailInput, listTimelineEvents }) as unknown as InstanceType<
        typeof MaintenanceRequestsService
      >,
  );
  vi.mocked(MaintenanceAttachmentsService).mockImplementation(
    () => ({ signedViewUrls }) as unknown as InstanceType<typeof MaintenanceAttachmentsService>,
  );
  vi.mocked(MaintenanceShareLinksService).mockImplementation(
    () => ({ ensureActiveLink }) as unknown as InstanceType<typeof MaintenanceShareLinksService>,
  );
  vi.mocked(withContext).mockResolvedValue(buildCtx() as never);
});

describe('RSC param safety (recurring pattern #1 / Task 8 forward requirement)', () => {
  it('a malformed id calls notFound() before checkModuleAccess or any service call — never renders, never 500s', async () => {
    await expect(
      MaintenanceRequestDetailPage({ params: Promise.resolve({ id: BAD_ID }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('notFound');
    expect(checkModuleAccess).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('a well-formed id the caller cannot see (get() throws not_found) calls notFound(), never an error-boundary crash', async () => {
    get.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found'));
    await expect(MaintenanceRequestDetailPage(args())).rejects.toThrow('notFound');
  });

  it('a non-not_found ServiceError from get() propagates instead of becoming notFound', async () => {
    get.mockRejectedValueOnce(new ServiceError('internal_error', 'boom'));
    await expect(MaintenanceRequestDetailPage(args())).rejects.toThrow('boom');
  });
});

describe('module gate', () => {
  it('refuses the page (renders ModuleNotEnabled) without ever calling get() when the module is disabled', async () => {
    moduleAccess.current = { enabled: false, canManage: true };
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByTestId('module-not-enabled')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(moduleNotEnabledProps).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'maintenance_requests', canManage: true }),
    );
  });
});

describe('internal notes gating (brief §5/§23 — manage-only, never a requester)', () => {
  it('a requester (submit only, no manage) never triggers listNotes and never sees the notes panel', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1' }));
    render(await MaintenanceRequestDetailPage(args()));
    expect(listNotes).not.toHaveBeenCalled();
    expect(screen.queryByText('Internal StockPilot notes')).not.toBeInTheDocument();
  });

  it('a read_all-only viewer (not the requester, not manage) also never triggers listNotes or sees notes', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'viewer-1', permissions: ['maintenance_requests:read_all'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    render(await MaintenanceRequestDetailPage(args()));
    expect(listNotes).not.toHaveBeenCalled();
    expect(screen.queryByText('Internal StockPilot notes')).not.toBeInTheDocument();
  });

  it('a manage-holder triggers listNotes and sees the resolved notes', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({
        userId: 'mgr-1',
        permissions: ['maintenance_requests:manage'],
        membersData: [{ user_id: 'mgr-1', user: { id: 'mgr-1', full_name: 'Andrew Rosas', email: 'andrew@l4l.org' } }],
      }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    listNotes.mockResolvedValueOnce([
      { id: 'n1', authorUserId: 'mgr-1', body: 'Ordered a replacement part.', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    render(await MaintenanceRequestDetailPage(args()));
    expect(listNotes).toHaveBeenCalledWith(VALID_ID);
    expect(screen.getByText('Internal StockPilot notes')).toBeInTheDocument();
    expect(screen.getByText('Ordered a replacement part.')).toBeInTheDocument();
  });
});

describe('share-link mint degrades gracefully (Task 10 I3 / Task 11 adjudication)', () => {
  it('a read_all-only viewer of a foreign request still gets a working page when ensureActiveLink refuses', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'viewer-1', permissions: ['maintenance_requests:read_all'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    signedViewUrls.mockResolvedValueOnce([
      { id: 'p1', originalFilename: 'ac.jpg', url: 'https://signed/ac.jpg', thumbUrl: null, width: 800, height: 600 },
    ]);
    ensureActiveLink.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'),
    );

    // The read must not fail — this is the exact mutation self-check named
    // in this task: "fail the whole page when share minting is refused".
    render(await MaintenanceRequestDetailPage(args()));

    expect(emailInput).toHaveBeenCalledWith(VALID_ID, { shareUrl: null });
    // Not a manager — the ShareLinkPanel affordance is not mounted for this
    // viewer at all, independent of the mint outcome.
    expect(screen.queryByText('Photo share link')).not.toBeInTheDocument();
  });

  it('a non-ServiceError failure from ensureActiveLink propagates instead of silently degrading', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'viewer-1', permissions: ['maintenance_requests:read_all'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    signedViewUrls.mockResolvedValueOnce([
      { id: 'p1', originalFilename: 'ac.jpg', url: 'https://signed/ac.jpg', thumbUrl: null, width: 800, height: 600 },
    ]);
    ensureActiveLink.mockRejectedValueOnce(new Error('boom'));
    await expect(MaintenanceRequestDetailPage(args())).rejects.toThrow('boom');
  });

  it('never attempts to mint a link when the request has zero photos', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture());
    signedViewUrls.mockResolvedValueOnce([]);
    render(await MaintenanceRequestDetailPage(args()));
    expect(ensureActiveLink).not.toHaveBeenCalled();
  });

  it('a manage-holder with photos sees the ShareLinkPanel showing the minted link', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture());
    signedViewUrls.mockResolvedValueOnce([
      { id: 'p1', originalFilename: 'ac.jpg', url: 'https://signed/ac.jpg', thumbUrl: null, width: 800, height: 600 },
    ]);
    ensureActiveLink.mockResolvedValueOnce({
      token: 'tok',
      url: 'https://stockpilotusa.com/m/tok',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByText('Photo share link')).toBeInTheDocument();
    expect(emailInput).toHaveBeenCalledWith(VALID_ID, { shareUrl: 'https://stockpilotusa.com/m/tok' });
  });
});

describe('share-link affordance tier (fix wave Important 2 — ensureActiveLink admits the owning requester, so the panel must too)', () => {
  it('Minor fold-in: the owning requester with photos gets a real minted share link end-to-end — sees Copy, never Revoke', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1' }));
    signedViewUrls.mockResolvedValueOnce([
      { id: 'p1', originalFilename: 'ac.jpg', url: 'https://signed/ac.jpg', thumbUrl: null, width: 800, height: 600 },
    ]);
    ensureActiveLink.mockResolvedValueOnce({
      token: 'tok',
      url: 'https://stockpilotusa.com/m/tok',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    render(await MaintenanceRequestDetailPage(args()));

    expect(ensureActiveLink).toHaveBeenCalledWith(VALID_ID);
    expect(emailInput).toHaveBeenCalledWith(VALID_ID, { shareUrl: 'https://stockpilotusa.com/m/tok' });
    expect(screen.getByText('Photo share link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy URL/ })).toBeInTheDocument();
    // MUTATION GUARD (3): a non-manage owning requester must never see
    // Revoke — revoke() (maintenance-share-links.ts) is genuinely
    // manage-only server-side, so a Revoke button here would only 403.
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('a manage-holder still sees BOTH Copy and Revoke (unchanged tier)', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    signedViewUrls.mockResolvedValueOnce([
      { id: 'p1', originalFilename: 'ac.jpg', url: 'https://signed/ac.jpg', thumbUrl: null, width: 800, height: 600 },
    ]);
    ensureActiveLink.mockResolvedValueOnce({
      token: 'tok',
      url: 'https://stockpilotusa.com/m/tok',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByRole('button', { name: /Copy URL/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('a read_all-only non-owner sees no panel at all, even when a link happens to resolve for someone else\'s request', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'viewer-1', permissions: ['maintenance_requests:read_all'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    signedViewUrls.mockResolvedValueOnce([
      { id: 'p1', originalFilename: 'ac.jpg', url: 'https://signed/ac.jpg', thumbUrl: null, width: 800, height: 600 },
    ]);
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.queryByText('Photo share link')).not.toBeInTheDocument();
  });
});

describe('StockPilot activity timeline honesty sweep (brief §20/§23)', () => {
  const FORBIDDEN = [
    'Ticket created',
    'Request submitted to Zendesk',
    'DC4 notified',
    'Andrew notified',
    'Ticket assigned',
    'Email sent',
    'Zendesk comment',
  ];

  it('shows only real StockPilot rows — draft-opened xN, owner assigned, archived — and never a forbidden phrase', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(
      detailFixture({
        outlookDraftOpenedAt: '2026-08-02T00:00:00.000Z',
        outlookDraftOpenCount: 3,
        localOwnerUserId: 'mgr-1',
        archivedAt: '2026-08-03T00:00:00.000Z',
        status: 'archived',
      }),
    );
    render(await MaintenanceRequestDetailPage(args()));

    expect(screen.getByText('StockPilot activity')).toBeInTheDocument();
    expect(screen.getByText('Request saved')).toBeInTheDocument();
    expect(screen.getByText(/Outlook draft opened/)).toBeInTheDocument();
    expect(screen.getByText(/×3/)).toBeInTheDocument();
    expect(screen.getByText('Local owner assigned')).toBeInTheDocument();
    expect(screen.getByText('Request archived')).toBeInTheDocument();

    // Sweep the WHOLE document body (Task 14's lesson: a portalled dialog
    // can hide banned copy from a container-scoped check).
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('a cancelled request shows "Request cancelled", never "Request archived"', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(
      detailFixture({ requesterUserId: 'u-1', cancelledAt: '2026-08-04T00:00:00.000Z', status: 'cancelled' }),
    );
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByText('Request cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Request archived')).not.toBeInTheDocument();
  });

  it('a fresh request with no draft/owner/close events shows only "Request saved"', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1' }));
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByText('Request saved')).toBeInTheDocument();
    expect(screen.queryByText(/Outlook draft opened/)).not.toBeInTheDocument();
    expect(screen.queryByText('Local owner assigned')).not.toBeInTheDocument();
    expect(screen.queryByText('Request archived')).not.toBeInTheDocument();
    expect(screen.queryByText('Request cancelled')).not.toBeInTheDocument();
  });
});

describe('activity timeline — audit-log driven rows (fix wave Important 1)', () => {
  it('renders a "Photo uploaded" row per attachment_added event, with its real timestamp — never the previous "unobtainable" justification', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture());
    listTimelineEvents.mockResolvedValueOnce([
      { event: 'maintenance_request.attachment_added', createdAt: '2026-08-01T13:00:00.000Z', extra: {} },
      { event: 'maintenance_request.attachment_added', createdAt: '2026-08-01T14:00:00.000Z', extra: {} },
    ]);
    render(await MaintenanceRequestDetailPage(args()));
    expect(listTimelineEvents).toHaveBeenCalledWith(VALID_ID);
    expect(screen.getAllByText('Photo uploaded')).toHaveLength(2);
  });

  it('renders a REAL timestamp on "Local owner assigned" from the owner_assigned event — never the previous em-dash placeholder', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ localOwnerUserId: 'mgr-1' }));
    listTimelineEvents.mockResolvedValueOnce([
      { event: 'maintenance_request.owner_assigned', createdAt: '2026-08-02T00:00:00.000Z', extra: {} },
    ]);
    render(await MaintenanceRequestDetailPage(args()));
    const row = screen.getByText('Local owner assigned').closest('div');
    expect(row?.textContent).not.toContain('—');
  });

  it('takes the MOST RECENT owner_assigned event when the owner was reassigned more than once', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ localOwnerUserId: 'mgr-1' }));
    listTimelineEvents.mockResolvedValueOnce([
      { event: 'maintenance_request.owner_assigned', createdAt: '2026-01-01T00:00:00.000Z', extra: {} },
      { event: 'maintenance_request.owner_assigned', createdAt: '2026-08-02T00:00:00.000Z', extra: {} },
    ]);
    render(await MaintenanceRequestDetailPage(args()));
    // formatRelative renders a relative string, not the raw ISO stamp — the
    // MUTATION-relevant assertion is ONE row, not two duplicated ones, and
    // it must not fall back to the em-dash placeholder.
    const row = screen.getByText('Local owner assigned').closest('div');
    expect(row?.textContent).not.toContain('—');
  });

  it('an event type NOT on the allow-list never renders — the page only ever recognizes attachment_added and owner_assigned', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture());
    // The service itself allow-lists at the query AND the JS-filter layer
    // (maintenance-requests.test.ts pins both), so this array is not
    // achievable from a real call — this test instead proves the PAGE has
    // its own independent, second allow-list: even handed a disallowed
    // event directly (as if the service's own guard were ever bypassed),
    // the page must not render anything for it.
    listTimelineEvents.mockResolvedValueOnce([
      { event: 'maintenance_request.note_added', createdAt: '2026-08-01T00:00:00.000Z', extra: {} },
    ]);
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.queryByText('Photo uploaded')).not.toBeInTheDocument();
    // Substring check on the whole body — a raw event-kind fallback (e.g.
    // literally rendering `ev.event`) would produce a text node CONTAINING
    // "note_added" even though it isn't an exact match for it, so an exact
    // getByText('note_added') alone would miss that mutation.
    expect(document.body.textContent).not.toContain('note_added');
    // "Request saved" is the only row a fresh request (no draft/owner/close
    // events) should show — an unlisted event must add NO extra row at all.
    expect(screen.getByText('Request saved')).toBeInTheDocument();
  });

  it('never fetches the timeline in ?review=1 mode', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1' }));
    render(await MaintenanceRequestDetailPage(args({ review: '1' })));
    expect(listTimelineEvents).not.toHaveBeenCalled();
  });
});

describe('?review=1 mode (Task 13 post-save redirect target)', () => {
  it('renders MaintenanceReview in place of the two-column detail layout', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1' }));
    render(await MaintenanceRequestDetailPage(args({ review: '1' })));
    expect(screen.getByText('Review maintenance request')).toBeInTheDocument();
    expect(screen.queryByText('StockPilot activity')).not.toBeInTheDocument();
  });
});

describe('archive/cancel affordance gating', () => {
  it('the owning requester sees Cancel but not Archive', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1' }));
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('a manage-holder who is not the requester sees Archive but not Cancel', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'mgr-1', permissions: ['maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'someone-else' }));
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).not.toBeInTheDocument();
  });

  it('a closed request shows neither button', async () => {
    vi.mocked(withContext).mockResolvedValue(
      buildCtx({ userId: 'u-1', permissions: ['maintenance_requests:submit', 'maintenance_requests:manage'] }) as never,
    );
    get.mockResolvedValueOnce(detailFixture({ requesterUserId: 'u-1', archivedAt: '2026-08-03T00:00:00.000Z' }));
    render(await MaintenanceRequestDetailPage(args()));
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).not.toBeInTheDocument();
  });
});
