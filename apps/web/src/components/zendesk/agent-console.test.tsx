import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before the component import so Vitest can hoist them.
// ---------------------------------------------------------------------------
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Component under test (imported AFTER mocks so the mock is in place)
// ---------------------------------------------------------------------------
import { AgentConsole } from './agent-console';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const MOCK_TICKET = {
  id: 42,
  subject: 'My monitor is broken',
  status: 'open',
  priority: 'high',
  description: 'It stopped working yesterday.',
  createdAt: '2024-01-01T10:00:00Z',
  updatedAt: '2024-01-02T12:00:00Z',
  requesterId: 101,
  assigneeId: 202,
  url: 'https://acme.zendesk.com/tickets/42',
};

const MOCK_COMMENT = {
  id: 1,
  authorId: 101,
  body: 'Hello, can you help me?',
  public: true,
  createdAt: '2024-01-01T10:05:00Z',
};

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------
function mockFetch(
  responses: Array<{ url: string | RegExp; data: unknown; status?: number }>,
) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const urlStr = url.toString();
    // Sort by specificity: longer string patterns come before shorter ones,
    // so "/me/tickets/42" beats "/me/tickets" beats "/me".
    const sorted = [...responses].sort((a, b) => {
      if (a.url instanceof RegExp || b.url instanceof RegExp) return 0;
      return (b.url as string).length - (a.url as string).length;
    });
    const match = sorted.find((r) =>
      r.url instanceof RegExp ? r.url.test(urlStr) : urlStr.includes(r.url as string),
    );
    if (!match) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'not_found' }),
      };
    }
    const status = match.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => match.data,
    };
  }) as unknown as typeof fetch;

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('AgentConsole', () => {
  it('shows the Connect card (with link to oauth/start) when GET /me returns connected:false', async () => {
    mockFetch([{ url: '/api/v1/zendesk/me', data: { connected: false } }]);

    render(<AgentConsole />);

    // Should resolve to the connect card.
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /connect/i }),
      ).toHaveAttribute('href', '/api/v1/zendesk/oauth/start');
    });
  });

  it('renders ticket rows when connected and tickets are returned', async () => {
    mockFetch([
      { url: '/api/v1/zendesk/me', data: { connected: true, account: {} } },
      { url: '/api/v1/zendesk/me/tickets', data: { tickets: [MOCK_TICKET] } },
    ]);

    render(<AgentConsole />);

    await waitFor(() => {
      expect(screen.getByText('My monitor is broken')).toBeInTheDocument();
    });
  });

  it('shows the Connect card with session-expired copy when GET /me returns 401', async () => {
    mockFetch([
      { url: '/api/v1/zendesk/me', data: { error: 'reauth_required' }, status: 401 },
    ]);

    render(<AgentConsole />);

    // The connect link must be present (reauth also shows the connect card).
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /connect/i }),
      ).toHaveAttribute('href', '/api/v1/zendesk/oauth/start');
    });

    // Session-expired copy should be visible.
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it('loads ticket detail with comments when a row is clicked', async () => {
    mockFetch([
      { url: '/api/v1/zendesk/me', data: { connected: true, account: {} } },
      { url: '/api/v1/zendesk/me/tickets', data: { tickets: [MOCK_TICKET] } },
      {
        url: '/api/v1/zendesk/me/tickets/42',
        data: { ticket: MOCK_TICKET, comments: [MOCK_COMMENT] },
      },
    ]);

    render(<AgentConsole />);

    // Wait for the ticket list to appear.
    const row = await screen.findByText('My monitor is broken');
    fireEvent.click(row);

    // Wait for the comment body to appear in the detail pane.
    await waitFor(() => {
      expect(screen.getByText('Hello, can you help me?')).toBeInTheDocument();
    });
  });
});
