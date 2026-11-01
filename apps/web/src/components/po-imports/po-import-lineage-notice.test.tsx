// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PoImportLineageNotice } from './po-import-lineage-notice';

import type { PoImportLineage, PoImportLineageRef } from '@/server/services/po-imports';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function ref(over: Partial<PoImportLineageRef> = {}): PoImportLineageRef {
  return {
    id: '90f9fc56-0000-4000-8000-000000000000',
    fileName: 'PO-DEMO-002201.pdf',
    displayName: null,
    createdAt: '2026-07-20T10:00:00Z',
    status: 'approved',
    poId: null,
    poNumber: null,
    poStatus: null,
    ...over,
  };
}

function lineage(over: Partial<PoImportLineage> = {}): PoImportLineage {
  return { predecessor: null, successors: [], ...over };
}

/** The organization's zone, as the page resolves it. */
const TZ = 'America/Los_Angeles';

describe('PoImportLineageNotice', () => {
  it('never claims the linked successor is the live import', () => {
    // PoImportsService.resolveLineage walks exactly ONE hop
    // (.eq('reimported_from_id', header.id)). On the production chain
    // 4db2d72c -> 90f9fc56 -> 568a0712 the successor rendered here is itself
    // superseded, so "that newer import is the live one" is false and sends
    // the user to a page that says it was replaced too.
    render(<PoImportLineageNotice lineage={lineage({ successors: [ref()] })} timeZone={TZ} />);

    expect(screen.getByText(/replaced by a later import/i)).toBeInTheDocument();
    expect(screen.queryByText(/is the live one/i)).not.toBeInTheDocument();
    expect(screen.getByText(/if it was replaced in turn, it says so too/i)).toBeInTheDocument();
  });

  it('links to the resolved successor so the chain can be walked a hop at a time', () => {
    render(<PoImportLineageNotice lineage={lineage({ successors: [ref()] })} timeZone={TZ} />);
    expect(screen.getByRole('link', { name: /open the newer import/i })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/imports/90f9fc56-0000-4000-8000-000000000000',
    );
  });

  it('renders nothing when the import is neither superseded nor a redo', () => {
    const { container } = render(<PoImportLineageNotice lineage={lineage()} timeZone={TZ} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('lineage notice prefers the human name (mig 0333)', () => {
  it('renders the predecessor display name instead of the raw filename', () => {
    render(
      <PoImportLineageNotice
        lineage={{
          predecessor: ref({ displayName: 'August DC4 Book Order' }),
          successors: [],
        }}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText(/August DC4 Book Order/)).toBeInTheDocument();
    // The whole point of the feature: the camera filename must not be the label.
    expect(screen.queryByText(/PO-DEMO-002201\.pdf/)).not.toBeInTheDocument();
  });

  it('falls back to the filename for an unnamed predecessor', () => {
    render(
      <PoImportLineageNotice
        lineage={{ predecessor: ref({ displayName: null }), successors: [] }}
        timeZone={TZ}
      />,
    );
    expect(screen.getByText(/PO-DEMO-002201\.pdf/)).toBeInTheDocument();
  });
});

describe('lineage notice dates the later import as a calendar day', () => {
  // People track imports against a calendar (owner request 2026-09-24, the
  // imports list's Uploaded column). The notice said "imported again 2 weeks
  // ago", which drifts as the page sits open and names no day at all.
  // 2026-09-10 02:30 UTC is the evening of Sep 9 in California.
  const later = ref({ createdAt: '2026-09-10T02:30:00Z' });

  it("names the day in the organization's zone, with the time on hover, never a relative time", () => {
    render(<PoImportLineageNotice lineage={lineage({ successors: [later] })} timeZone={TZ} />);
    const when = screen.getByText('Sep 9, 2026');
    expect(when.tagName).toBe('TIME');
    expect(when).toHaveAttribute('dateTime', '2026-09-10T02:30:00Z');
    expect(when).toHaveAttribute('title', 'Sep 9, 2026, 7:30 PM');
    expect(screen.getByText(/this file was imported again on/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/\bago\b|\bin \d+ (day|week|month|year)s?\b|yesterday|tomorrow/i),
    ).toBeNull();
  });

  it("follows the organization's zone, not the server's or the viewer's", () => {
    render(
      <PoImportLineageNotice lineage={lineage({ successors: [later] })} timeZone="Asia/Tokyo" />,
    );
    expect(screen.getByText('Sep 10, 2026')).toHaveAttribute('title', 'Sep 10, 2026, 11:30 AM');
  });
});
