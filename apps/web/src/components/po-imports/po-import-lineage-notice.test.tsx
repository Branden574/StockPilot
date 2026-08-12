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
    fileName: 'PO-CVW-002201.pdf',
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

describe('PoImportLineageNotice', () => {
  it('never claims the linked successor is the live import', () => {
    // PoImportsService.resolveLineage walks exactly ONE hop
    // (.eq('reimported_from_id', header.id)). On the production chain
    // 4db2d72c -> 90f9fc56 -> 568a0712 the successor rendered here is itself
    // superseded, so "that newer import is the live one" is false and sends
    // the user to a page that says it was replaced too.
    render(<PoImportLineageNotice lineage={lineage({ successors: [ref()] })} />);

    expect(screen.getByText(/replaced by a later import/i)).toBeInTheDocument();
    expect(screen.queryByText(/is the live one/i)).not.toBeInTheDocument();
    expect(screen.getByText(/if it was replaced in turn, it says so too/i)).toBeInTheDocument();
  });

  it('links to the resolved successor so the chain can be walked a hop at a time', () => {
    render(<PoImportLineageNotice lineage={lineage({ successors: [ref()] })} />);
    expect(screen.getByRole('link', { name: /open the newer import/i })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/imports/90f9fc56-0000-4000-8000-000000000000',
    );
  });

  it('renders nothing when the import is neither superseded nor a redo', () => {
    const { container } = render(<PoImportLineageNotice lineage={lineage()} />);
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
      />,
    );
    expect(screen.getByText(/August DC4 Book Order/)).toBeInTheDocument();
    // The whole point of the feature: the camera filename must not be the label.
    expect(screen.queryByText(/PO-CVW-002201\.pdf/)).not.toBeInTheDocument();
  });

  it('falls back to the filename for an unnamed predecessor', () => {
    render(
      <PoImportLineageNotice
        lineage={{ predecessor: ref({ displayName: null }), successors: [] }}
      />,
    );
    expect(screen.getByText(/PO-CVW-002201\.pdf/)).toBeInTheDocument();
  });
});
