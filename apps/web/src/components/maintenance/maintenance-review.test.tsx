import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// MaintenanceEmailAction imports the real server-action module, which
// transitively imports the `server-only`-guarded service — throws under
// Vitest's happy-dom env. Mocked for the same reason its own test does.
vi.mock('@/server/actions/maintenance-requests', () => ({
  recordMaintenanceDraftOpenedAction: vi.fn(async () => ({ ok: true as const, openCount: 0 })),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import type { MaintenanceEmailContent, OrgEmailRoutingState } from '@stockpilot/core';
import type { MaintenanceRequestDetail } from '@/server/services/maintenance-requests';
import type { PanelPhoto } from './maintenance-photos-panel';

import { MaintenanceReview } from './maintenance-review';

/** The routing the L4L seed resolves to — keeps every pin below on the
 *  pre-feature behavior. The hidden states get their own describe below. */
const VALID_ROUTING: OrgEmailRoutingState = {
  state: 'valid',
  recipients: {
    to: 'dc4@learn4life.org',
    cc: 'arosas@cvwest.org',
    toName: 'Fresno Warehouse DC4',
    ccName: 'Andrew Rosas',
  },
};

// Every field of the REAL interface, not a partial cast — a future
// rename/removal breaks this fixture, not just an inference.
const DETAIL: MaintenanceRequestDetail = {
  id: 'r1',
  requestNumber: 123,
  createdAt: '2026-08-05T16:15:00Z',
  subject: 'AC broken in Room 204',
  status: 'saved',
  priority: 'high',
  category: null,
  siteName: 'Fresno Learning Center',
  requesterName: 'Jane Smith',
  requesterUserId: null,
  photoCount: 1,
  draftOpened: false,
  localOwnerUserId: null,
  description: 'Warm air only.',
  requesterEmail: null,
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
  resolvedAt: null,
  resolvedByName: null,
  resolutionNote: null,
  updatedAt: '2026-08-05T16:15:00Z',
};

const EMAIL_INPUT: MaintenanceEmailContent = {
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
  photoCount: 1,
  shareUrl: null,
};

const PHOTOS: PanelPhoto[] = [
  { id: 'p1', originalFilename: 'ac-unit.jpg', url: 'https://files.example.test/ac-unit.jpg', thumbUrl: null },
];

describe('MaintenanceReview owner-mandated copy (brief §10, §12)', () => {
  it('pins the review title, the saved-not-sent sentence, and the Outlook-photos sentence verbatim, exactly once', () => {
    render(
      <MaintenanceReview
        detail={DETAIL}
        photos={PHOTOS}
        emailInput={EMAIL_INPUT}
        emailRouting={VALID_ROUTING}
        canConfigureRouting={false}
        initialOpenCount={0}
      />,
    );
    expect(screen.getByText('Review maintenance request')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your request has been saved in StockPilot. Outlook will open with the email details filled in, but the email will not be sent automatically.',
      ),
    ).toBeInTheDocument();
    // Minor 6: photoDownloads is no longer passed into MaintenanceEmailAction,
    // so this sentence and its "Download Photos for Outlook" heading render
    // exactly once — getByText throws on a duplicate.
    expect(
      screen.getByText(
        'Outlook cannot add StockPilot photos automatically. The photo links will be included in the message, and you can download the photos here if you want to attach them directly.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Download Photos for Outlook')).toHaveLength(1);
  });
});

/**
 * Per-org email routing (migration 0337) — the fallback matrix on the
 * post-save review screen: 'valid' composes, 'unset'/'invalid' hide every
 * email affordance for members and show only the admin pointer for
 * organization:update holders. The record itself (details, photos) is
 * untouched in every state.
 */
describe('MaintenanceReview x email routing states', () => {
  it('VALID: shows the notice as a pure function of the resolved recipients', () => {
    render(
      <MaintenanceReview
        detail={DETAIL}
        photos={[]}
        emailInput={EMAIL_INPUT}
        emailRouting={VALID_ROUTING}
        canConfigureRouting={false}
        initialOpenCount={0}
      />,
    );
    expect(
      screen.getByText(
        'This request will be emailed to dc4@learn4life.org. A copy will also be sent to arosas@cvwest.org.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in Outlook/i })).toBeInTheDocument();
  });

  it('UNSET x member: NO email preview, NO compose buttons, NO hint — and no compiled address anywhere', () => {
    const { container } = render(
      <MaintenanceReview
        detail={DETAIL}
        photos={[]}
        emailInput={EMAIL_INPUT}
        emailRouting={{ state: 'unset' }}
        canConfigureRouting={false}
        initialOpenCount={0}
      />,
    );
    expect(screen.queryByRole('button', { name: /Open in Outlook/i })).toBeNull();
    expect(screen.queryByText('Email preview')).toBeNull();
    expect(screen.queryByTestId('maintenance-routing-hint')).toBeNull();
    // The record flow survives; the compiled tenant addresses do not appear.
    expect(screen.getByText('Review maintenance request')).toBeInTheDocument();
    expect(container.textContent).not.toContain('learn4life');
    expect(container.textContent).not.toContain('cvwest');
    // The saved sentence no longer promises an Outlook window that will
    // never open.
    expect(screen.getByText('Your request has been saved in StockPilot.')).toBeInTheDocument();
  });

  it('UNSET x admin: the pointer to Settings renders instead of the compose block', () => {
    render(
      <MaintenanceReview
        detail={DETAIL}
        photos={[]}
        emailInput={EMAIL_INPUT}
        emailRouting={{ state: 'unset' }}
        canConfigureRouting={true}
        initialOpenCount={0}
      />,
    );
    expect(screen.queryByRole('button', { name: /Open in Outlook/i })).toBeNull();
    const hint = screen.getByTestId('maintenance-routing-hint');
    expect(hint).toHaveTextContent('Email routing is not configured for this organization');
  });

  it('INVALID x admin: the verbatim guard reason surfaces; no compose, no compiled fallback', () => {
    const { container } = render(
      <MaintenanceReview
        detail={DETAIL}
        photos={[]}
        emailInput={EMAIL_INPUT}
        emailRouting={{
          state: 'invalid',
          reason:
            'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.',
        }}
        canConfigureRouting={true}
        initialOpenCount={0}
      />,
    );
    expect(screen.queryByRole('button', { name: /Open in Outlook/i })).toBeNull();
    const hint = screen.getByTestId('maintenance-routing-hint');
    expect(hint).toHaveTextContent('Email routing for maintenance requests is invalid');
    expect(hint).toHaveTextContent('must be exactly one plain email address');
    expect(container.textContent).not.toContain('learn4life');
  });
});
