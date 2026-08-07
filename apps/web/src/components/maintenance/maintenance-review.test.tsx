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

import type { MaintenanceEmailInput } from '@stockpilot/core';
import type { MaintenanceRequestDetail } from '@/server/services/maintenance-requests';
import type { PanelPhoto } from './maintenance-photos-panel';

import { MaintenanceReview } from './maintenance-review';

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

const EMAIL_INPUT: MaintenanceEmailInput = {
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
    render(<MaintenanceReview detail={DETAIL} photos={PHOTOS} emailInput={EMAIL_INPUT} initialOpenCount={0} />);
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
