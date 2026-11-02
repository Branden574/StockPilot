import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B9 review: a comment's time tooltip printed the server's clock (UTC on
 * Vercel) with no zone named, because the discussion is rendered on the server
 * first. The page now reads the organization's zone (the request-cached org row
 * the dashboard layout already holds) and hands it to the discussion.
 */

const h = vi.hoisted(() => ({
  threadProps: vi.fn(),
  orgRow: vi.fn(),
  reportError: vi.fn(),
  procedureGet: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff',
    permissions: new Set<string>(),
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({ getOrgRowForRequest: h.orgRow }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/procedures', () => ({
  ProceduresService: {
    forCurrentUser: vi.fn(async () => ({
      get: async (id: string) => {
        h.procedureGet(id);
        return {
          id: '5eed0000-0000-4000-8000-0000000000d1',
          title: 'Receiving a pallet',
          category_name: null,
          category_color: null,
          created_by_name: null,
          authoring_warehouse_name: null,
          created_at: '2026-10-01T16:00:00.000Z',
          description: null,
          videos: [],
          body: '',
          comments: [],
        };
      },
    })),
  },
}));
vi.mock('@/components/procedures/comment-thread', () => ({
  CommentThread: (props: Record<string, unknown>) => {
    h.threadProps(props);
    return null;
  },
}));
vi.mock('@/components/procedures/comment-composer', () => ({ CommentComposer: () => null }));
vi.mock('@/components/procedures/archive-button', () => ({ ArchiveButton: () => null }));
vi.mock('@/components/procedures/video-player', () => ({ VideoPlayer: () => null }));
vi.mock('@/components/procedures/markdown-body', () => ({ MarkdownBody: () => null }));

import ProcedureDetailPage from './page';

const PROCEDURE_ID = '5eed0000-0000-4000-8000-0000000000d1';

const params = () => Promise.resolve({ id: PROCEDURE_ID });

beforeEach(() => vi.clearAllMocks());

describe("Procedure page: the discussion gets the organization's time zone", () => {
  it("passes the organization's stored zone", async () => {
    h.orgRow.mockResolvedValue({ timezone: 'America/New_York' });

    render(await ProcedureDetailPage({ params: params() }));

    expect(h.orgRow).toHaveBeenCalledWith('org-1');
    expect(h.threadProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ procedureId: PROCEDURE_ID, timeZone: 'America/New_York' }),
    );
  });

  it('a row that cannot be read is the documented default zone, reported, and the page still renders', async () => {
    h.orgRow.mockRejectedValue(new Error('getOrgRowForRequest: fetch failed'));

    render(await ProcedureDetailPage({ params: params() }));

    expect(h.threadProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeZone: 'America/Los_Angeles' }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'warning' }),
    );
  });
});

// B63: a mistyped or cut-off link is Page not found before the procedure is
// read. The service refused it with validation_error, which the page did not
// map, so it reached the error boundary as "Something broke loading this page".
describe('Procedure page: an id that is not a uuid', () => {
  it('is the not-found page, with nothing read', async () => {
    const { requireOrgContext } = await import('@/lib/auth/session');
    for (const id of ['not-a-uuid', PROCEDURE_ID.slice(0, -1)]) {
      await expect(ProcedureDetailPage({ params: Promise.resolve({ id }) }), id).rejects.toThrow(
        'NEXT_NOT_FOUND',
      );
    }
    expect(h.procedureGet).not.toHaveBeenCalled();
    expect(requireOrgContext).not.toHaveBeenCalled();
  });
});
