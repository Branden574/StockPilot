import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The AI page tells the chat panel whether this person can open Bulk ISBN
 * import (docket B76): the panel's note for a file with more ISBNs than the
 * assistant adds at a time links there only then. The import page needs
 * items:import, and its way back is the Books page, which needs the Books
 * module, so both are required. Without them the note asks for a smaller file.
 */

const h = vi.hoisted(() => ({
  modules: {} as Record<string, { enabled: boolean; canManage: boolean; checkFailed?: boolean }>,
  asked: [] as string[],
  permissions: new Set<string>(),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (moduleId: string) => {
    h.asked.push(moduleId);
    return h.modules[moduleId] ?? { enabled: false, canManage: false };
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff',
    permissions: h.permissions,
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/ai/chat-panel', () => ({
  ChatPanel: ({ canOpenBulkIsbnImport }: { canOpenBulkIsbnImport?: boolean }) => (
    <p data-testid="chat-panel">
      {canOpenBulkIsbnImport ? 'links to Bulk ISBN import' : 'no link'}
    </p>
  ),
}));

import AiPage from './page';

const ON = { enabled: true, canManage: false };

async function panel() {
  render(await AiPage());
  return screen.getByTestId('chat-panel').textContent;
}

beforeEach(() => {
  h.asked = [];
  h.modules = { ai: ON, books: ON };
  h.permissions = new Set(['items:update', 'items:create', 'items:import']);
});

describe('AI page: the Bulk ISBN import link (B76)', () => {
  it('is offered with the Books module and items:import, after the page gates', async () => {
    expect(await panel()).toBe('links to Bulk ISBN import');
    expect(h.asked).toEqual(['ai', 'books']);
  });

  it('is not offered when the Books module is off, or could not be checked', async () => {
    h.modules.books = { enabled: false, canManage: false };
    expect(await panel()).toBe('no link');
    cleanup();
    h.modules.books = { enabled: false, canManage: false, checkFailed: true };
    expect(await panel()).toBe('no link');
  });

  it('is not offered without items:import, even with items:create', async () => {
    h.permissions = new Set(['items:update', 'items:create']);
    expect(await panel()).toBe('no link');
  });
});
