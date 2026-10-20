import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Staging page in the redesign (P4.A2, matrix W-BK-06): the shared page
// header with its one h1 (the tour's `main h1` step), the tour in the header,
// the subline kept word for word, and every gate and parameter the page reads
// handed on to the streamed section exactly as before.

const ctxHolder = vi.hoisted(() => ({
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  permissions: undefined as Set<string> | undefined,
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.role,
    permissions: ctxHolder.permissions,
  })),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

const sectionProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/inventory/staging-table-section', () => ({
  StagingTableSection: (props: Record<string, unknown>) => {
    sectionProps.current = props;
    return <div data-testid="staging-section" />;
  },
}));

vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: ({ tour }: { tour: { id: string } }) => (
    <button type="button" data-testid="page-tour" data-tour={tour.id}>
      Tour
    </button>
  ),
}));

import StagingPage from './page';

async function renderPage(params: Record<string, string | string[]> = {}) {
  const ui = await StagingPage({ searchParams: Promise.resolve(params) });
  return render(ui);
}

beforeEach(() => {
  ctxHolder.role = 'manager';
  ctxHolder.permissions = undefined;
  sectionProps.current = null;
});

describe('Staging page (redesign)', () => {
  it('renders one h1 "Staging" in the shared page header, with the tour beside it and the subline kept', async () => {
    await renderPage();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Staging');
    expect(headings[0]!.closest('[data-slot="page-header"]')).not.toBeNull();
    expect(screen.getByTestId('page-tour')).toHaveAttribute('data-tour', 'staging-page');
    expect(
      screen.getByText(
        'Stock waiting to be placed into a rack or crate — received from POs (staged) or on hand but never placed (unplaced).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('staging-section')).toBeInTheDocument();
  });

  it('hands the section the type, the order filter and the Place gates unchanged', async () => {
    await renderPage({
      type: 'book',
      item: ['11111111-1111-4111-8111-111111111111'],
      order: '22222222-2222-4222-8222-222222222222',
    });
    const props = sectionProps.current!;
    expect(props.itemType).toBe('book');
    expect(props.canPlace).toBe(true);
    expect(props.canMintDestination).toBe(true);
    expect((props.filter as { state: string }).state).toBe('ok');
  });

  it('a viewer reads the page without Place, and an unknown type is ignored', async () => {
    ctxHolder.role = 'viewer';
    await renderPage({ type: 'everything' });
    const props = sectionProps.current!;
    expect(props.itemType).toBeUndefined();
    expect(props.canPlace).toBe(false);
  });

  it('a member without items:read gets notFound, as before', async () => {
    ctxHolder.permissions = new Set<string>();
    ctxHolder.role = 'staff';
    // An explicit empty permission set: nothing granted.
    await expect(StagingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/notFound/);
  });
});
