// The Zendesk page in the redesign (P4.F2, row W-WS-14).
//
// - CONFLICTS D23: the subline promised "(soon) an in-app agent console",
//   which the web does not have; the redesign promises nothing that is not
//   there.
// - The "since" time was formatted on the server (toLocaleString, so UTC on
//   Vercel and the server's locale): a different wall-clock time for the
//   viewer. It is now the viewer's own time, filled in by the browser.
// - The connect form and the subdomain editor stay for integrations:manage;
//   everyone else reads "Ask an admin to connect Zendesk."
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  conn: null as unknown,
  perms: new Set<string>(['integrations:manage']),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));
vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: h.perms.has('integrations:manage') ? 'admin' : 'staff',
    permissions: h.perms,
  })),
}));
vi.mock('@/server/services/connections', () => ({
  ConnectionsService: {
    forCurrentUser: vi.fn(async () => ({ getZendeskConnection: async () => h.conn })),
  },
}));
vi.mock('@/server/actions/zendesk', () => ({
  connectZendeskAction: vi.fn(),
  disconnectZendeskAction: vi.fn(),
  setZendeskSubdomainAction: vi.fn(),
}));

import ZendeskPage from './page';

beforeEach(() => {
  h.conn = null;
  h.perms = new Set(['integrations:manage']);
});

describe('Zendesk page', () => {
  it('has one h1 and no promise of a console that does not exist (D23)', async () => {
    render(await ZendeskPage());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Zendesk');
    expect(screen.getByText('Support tickets.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\(soon\)|agent console/);
  });

  it('prints the connected time in the viewer’s zone, never a server-formatted one', async () => {
    h.conn = {
      status: 'active',
      subdomain: 'acme',
      lastConnectedAt: '2026-07-16T05:28:00.000Z',
      lastError: null,
    };
    const page = await ZendeskPage();
    // The server's HTML carries no time at all (it would be UTC there).
    const html = renderToString(page);
    expect(html).toContain('Connected<!-- --> to acme.zendesk.com');
    expect(html).not.toContain('since');
    // In the browser the time is the viewer's local one.
    render(page);
    const local = new Date('2026-07-16T05:28:00.000Z').toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(await screen.findByText(`· since ${local}`)).toBeInTheDocument();
  });

  it('keeps the connect form for integrations:manage and the ask-an-admin line for everyone else', async () => {
    const { unmount } = render(await ZendeskPage());
    expect(screen.getByLabelText('Zendesk subdomain')).toBeInTheDocument();
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Connect Zendesk' })).toBeInTheDocument();
    unmount();

    h.perms = new Set();
    render(await ZendeskPage());
    expect(screen.queryByLabelText('Zendesk subdomain')).not.toBeInTheDocument();
    expect(screen.getByText('Ask an admin to connect Zendesk.')).toBeInTheDocument();
  });
});
