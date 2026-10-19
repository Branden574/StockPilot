// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New PO import keeps the imports list's module gate (P4.C1 fix). With PO
 * imports switched off every upload and scan action refuses on the server, so
 * the page used to offer two forms that could only fail on submit. It now
 * shows the same module-off panel the list shows (its words, and the Enable
 * link for someone who can enable modules), and with the module on both
 * upload cards render as before.
 */

const { access } = vi.hoisted(() => ({
  access: { current: { enabled: true, canManage: true } },
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => access.current),
}));
vi.mock('@/components/po-imports/po-scan-form', () => ({
  PoScanForm: () => <p>scan form</p>,
}));
vi.mock('@/components/po-imports/po-upload-form', () => ({
  PoUploadForm: () => <p>upload form</p>,
}));

import { checkModuleAccess } from '@/lib/modules/module-gate';

import NewPoImportPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  access.current = { enabled: true, canManage: true };
});

describe('New PO import: the po_imports module gate', () => {
  it('shows the module-off panel instead of the upload forms when PO imports is off', async () => {
    access.current = { enabled: false, canManage: true };
    render(await NewPoImportPage());

    expect(checkModuleAccess).toHaveBeenCalledWith('po_imports');
    expect(
      screen.getByRole('heading', { level: 1, name: "PO imports isn't enabled" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enable in Settings → Modules' })).toHaveAttribute(
      'href',
      '/dashboard/settings/modules',
    );
    expect(screen.queryByText('scan form')).toBeNull();
    expect(screen.queryByText('upload form')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'New PO import' })).toBeNull();
  });

  it('tells someone who cannot enable modules whom to ask', async () => {
    access.current = { enabled: false, canManage: false };
    render(await NewPoImportPage());

    expect(screen.getByText('Ask an owner or admin to enable it.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Enable in Settings/ })).toBeNull();
    expect(screen.queryByText('scan form')).toBeNull();
  });

  it('renders the page and both upload cards when the module is on', async () => {
    render(await NewPoImportPage());

    expect(screen.getByRole('heading', { level: 1, name: 'New PO import' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Scan with AI' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Upload CSV / structured PDF' }),
    ).toBeInTheDocument();
    expect(screen.getByText('scan form')).toBeInTheDocument();
    expect(screen.getByText('upload form')).toBeInTheDocument();
  });
});
