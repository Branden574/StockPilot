import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Edit procedure: the form with the procedure's values for someone who may
 * manage procedures (categories:manage), not found for anyone else and for a
 * procedure the reader cannot open. A link whose id is not a uuid is Page not
 * found before anything is read (B63).
 */

const h = vi.hoisted(() => ({
  role: 'manager' as 'manager' | 'staff',
  procedureGet: vi.fn(),
  formProps: vi.fn(),
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
    role: h.role,
  })),
}));
vi.mock('@/server/services/procedures', () => ({
  ProceduresService: { forCurrentUser: vi.fn(async () => ({ get: h.procedureGet })) },
}));
vi.mock('@/server/services/procedure-categories', () => ({
  ProcedureCategoriesService: {
    forCurrentUser: vi.fn(async () => ({
      list: async () => [{ id: 'cat-1', name: 'Receiving', color: '#336699' }],
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: async () => [{ id: 'wh-1', name: 'North DC' }],
    })),
  },
}));
vi.mock('@/components/procedures/procedure-form', () => ({
  ProcedureForm: (props: Record<string, unknown>) => {
    h.formProps(props);
    return <p data-testid="procedure-form" />;
  },
}));
vi.mock('@/components/procedures/upload-recovery-toast', () => ({
  UploadRecoveryToast: () => null,
}));

import { ServiceError } from '@/server/services/context';

import EditProcedurePage from './page';

const PROCEDURE_ID = '5eed0000-0000-4000-8000-0000000000d1';

function procedure() {
  return {
    id: PROCEDURE_ID,
    title: 'Receiving a pallet',
    description: null,
    body: 'Check the count first.',
    category_id: 'cat-1',
    authoring_warehouse_id: 'wh-1',
    updated_at: '2026-10-01T16:00:00.000Z',
    videos: [],
  };
}

const open = (id = PROCEDURE_ID) => EditProcedurePage({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'manager';
  h.procedureGet.mockResolvedValue(procedure());
});

describe('Edit procedure page', () => {
  it("opens the form with the procedure's values and the way back to it", async () => {
    render(await open());
    expect(screen.getByRole('heading', { level: 1, name: 'Edit procedure' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to procedure/ })).toHaveAttribute(
      'href',
      `/dashboard/procedures/${PROCEDURE_ID}`,
    );
    expect(h.procedureGet).toHaveBeenCalledWith(PROCEDURE_ID);
    expect(h.formProps).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit',
        defaults: expect.objectContaining({ id: PROCEDURE_ID, title: 'Receiving a pallet' }),
      }),
    );
  });

  it('is not found for someone without categories:manage, and for a procedure the reader cannot open', async () => {
    h.role = 'staff';
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.procedureGet).not.toHaveBeenCalled();

    h.role = 'manager';
    h.procedureGet.mockRejectedValue(new ServiceError('not_found', 'Procedure not found'));
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a failed read is not a 404: it reaches the error boundary as itself', async () => {
    const failure = new ServiceError('internal_error', 'gateway timeout');
    h.procedureGet.mockRejectedValue(failure);
    await expect(open()).rejects.toBe(failure);
  });

  // B63: the service refused a malformed id with validation_error, which the
  // page did not map, so a mistyped or cut-off link reached the error boundary
  // as "Something broke loading this page".
  it('an id that is not a uuid is the not-found page, with nothing read', async () => {
    const { requireOrgContext } = await import('@/lib/auth/session');
    for (const id of ['not-a-uuid', PROCEDURE_ID.slice(0, -1)]) {
      await expect(open(id), id).rejects.toThrow('NEXT_NOT_FOUND');
    }
    expect(h.procedureGet).not.toHaveBeenCalled();
    expect(requireOrgContext).not.toHaveBeenCalled();
  });
});
