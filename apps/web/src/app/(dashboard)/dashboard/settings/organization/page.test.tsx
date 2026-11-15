import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TERMINOLOGY } from '@stockpilot/core';

/**
 * The Organization settings page reads one organizations row and seeds every
 * editor from it. The labels editor saves the whole terminology object and
 * the PO terms editor saves the whole text, so editors seeded from defaults
 * while the row could not be read would write those defaults over what is
 * stored. An unreadable row shows the failed-read state and no editors.
 */

type Row = {
  terminology?: Record<string, string> | null;
  name?: string | null;
  logo_url?: string | null;
  po_terms?: string | null;
  timezone?: string | null;
};

const orgResult = vi.hoisted(() => ({
  current: {
    data: null as Row | null,
    error: null as { code: string; message: string } | null,
  },
}));
const READ_ERROR = { code: '08006', message: 'connection reset' };

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'owner',
  })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== 'organizations') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => orgResult.current,
          }),
        }),
      };
    },
  }),
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ refresh }),
  usePathname: () => '/dashboard/settings/organization',
}));

const reportError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const editorProps = vi.hoisted(() => ({
  logo: vi.fn(),
  name: vi.fn(),
  timezone: vi.fn(),
  terminology: vi.fn(),
  poTerms: vi.fn(),
}));
vi.mock('@/components/settings/org-logo-uploader', () => ({
  OrgLogoUploader: (p: Record<string, unknown>) => {
    editorProps.logo(p);
    return <div data-testid="org-logo-uploader" />;
  },
}));
vi.mock('@/components/settings/org-name-editor', () => ({
  OrgNameEditor: (p: Record<string, unknown>) => {
    editorProps.name(p);
    return <div data-testid="org-name-editor" />;
  },
}));
vi.mock('@/components/settings/org-timezone-editor', () => ({
  OrgTimezoneEditor: (p: Record<string, unknown>) => {
    editorProps.timezone(p);
    return <div data-testid="org-timezone-editor" />;
  },
}));
vi.mock('@/components/settings/terminology-editor', () => ({
  TerminologyEditor: (p: Record<string, unknown>) => {
    editorProps.terminology(p);
    return <div data-testid="terminology-editor" />;
  },
}));
vi.mock('@/components/settings/po-terms-editor', () => ({
  PoTermsEditor: (p: Record<string, unknown>) => {
    editorProps.poTerms(p);
    return <div data-testid="po-terms-editor" />;
  },
}));

import OrganizationSettingsPage from './page';

const EDITOR_IDS = [
  'org-logo-uploader',
  'org-name-editor',
  'org-timezone-editor',
  'terminology-editor',
  'po-terms-editor',
];

beforeEach(() => {
  vi.clearAllMocks();
  orgResult.current = { data: null, error: null };
});

describe('organization settings read', () => {
  it('an unreadable row shows the failed-read state with Try again, never an editor', async () => {
    orgResult.current = { data: null, error: READ_ERROR };
    render(await OrganizationSettingsPage());
    expect(screen.getByText("We couldn't load this settings page")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    for (const id of EDITOR_IDS) expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(editorProps.terminology).not.toHaveBeenCalled();
    expect(editorProps.poTerms).not.toHaveBeenCalled();
  });

  it('reports the failed read with its code', async () => {
    orgResult.current = { data: null, error: READ_ERROR };
    render(await OrganizationSettingsPage());
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = reportError.mock.calls[0] as unknown as [
      unknown,
      { tag: string; extra?: Record<string, unknown> },
    ];
    expect(context.tag).toBe('settings.organization.read_failed');
    expect(context.extra?.code).toBe('08006');
  });

  it('Try again asks the server for the page again', async () => {
    orgResult.current = { data: null, error: READ_ERROR };
    render(await OrganizationSettingsPage());
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('no row opens the editors with the defaults', async () => {
    orgResult.current = { data: null, error: null };
    render(await OrganizationSettingsPage());
    for (const id of EDITOR_IDS) expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load this settings page")).not.toBeInTheDocument();
    expect(editorProps.terminology.mock.calls[0]?.[0]).toMatchObject({
      current: DEFAULT_TERMINOLOGY,
    });
    expect(editorProps.poTerms.mock.calls[0]?.[0]).toMatchObject({ current: null });
    expect(editorProps.name.mock.calls[0]?.[0]).toMatchObject({ current: '' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a stored row opens the editors with its own values', async () => {
    orgResult.current = {
      data: {
        terminology: { charter_singular: 'Campus', charter_plural: 'Campuses' },
        name: 'Example Co',
        logo_url: null,
        po_terms: 'Net 30. Example terms.',
        timezone: 'America/Denver',
      },
      error: null,
    };
    render(await OrganizationSettingsPage());
    expect(editorProps.terminology.mock.calls[0]?.[0]).toMatchObject({
      current: { ...DEFAULT_TERMINOLOGY, charter_singular: 'Campus', charter_plural: 'Campuses' },
    });
    expect(editorProps.poTerms.mock.calls[0]?.[0]).toMatchObject({
      current: 'Net 30. Example terms.',
    });
    expect(editorProps.name.mock.calls[0]?.[0]).toMatchObject({ current: 'Example Co' });
    expect(editorProps.timezone.mock.calls[0]?.[0]).toMatchObject({
      current: 'America/Denver',
    });
  });
});
