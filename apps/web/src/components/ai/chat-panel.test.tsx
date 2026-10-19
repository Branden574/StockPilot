import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { ChatPanel, jumpLinkFor } from './chat-panel';

/**
 * The AI Assistant's conversation panel (redesign P4.F1, matrix W-WS-02):
 * the restyle keeps the tour anchor, the plain-text replies, the inline
 * Confirm / Cancel on a last turn ending "Confirm?", the tool chips and the
 * jump links, and fixes three things it found: the low-stock jump link that
 * opened the unfiltered list (CONFLICTS D4), the delete-chat button that was
 * invisible to keyboard and touch (D18), and New chat being unreachable below
 * md (the rail is hidden there).
 */

type Session = { id: string; title: string | null; createdAt: string; updatedAt: string };

const SESSIONS: Session[] = [
  {
    id: 's1',
    title: 'Low stock check',
    createdAt: '2026-10-18T10:00:00Z',
    updatedAt: '2026-10-18T10:05:00Z',
  },
];

const MESSAGES = [
  { role: 'user', content: 'What is low?', toolCalls: null },
  {
    role: 'assistant',
    content: 'Three items are low. <b>not bold</b>',
    toolCalls: [{ name: 'listLowStock', ok: true }],
  },
  { role: 'user', content: 'Adjust the mug by -2', toolCalls: null },
  {
    role: 'assistant',
    content: 'I will remove 2 from L4L Mug. Confirm?',
    toolCalls: [
      { name: 'adjustStock', ok: true },
      { name: 'searchInventory', ok: false },
    ],
  },
];

function mockFetch({ stored }: { stored: boolean }) {
  if (stored) window.localStorage.setItem('stockpilot.ai.activeSession', 's1');
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/ai/sessions') {
      return new Response(JSON.stringify({ ok: true, sessions: SESSIONS }), { status: 200 });
    }
    if (url === '/api/ai/sessions/s1' && (!init || !init.method)) {
      return new Response(JSON.stringify({ ok: true, messages: MESSAGES }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no scrollTo on elements.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jumpLinkFor', () => {
  it('sends the low-stock list to the filter the Items page reads (D4)', () => {
    expect(jumpLinkFor([{ name: 'listLowStock', ok: true }])).toEqual({
      label: 'Open low-stock list',
      href: '/dashboard/inventory?stock=low&type=all',
    });
  });

  it('keeps the other mappings and ignores failed tools', () => {
    expect(jumpLinkFor([{ name: 'adjustStock', ok: true }])?.href).toBe('/dashboard/movements');
    expect(jumpLinkFor([{ name: 'approveOrder', ok: true }])?.label).toBe('Open orders dashboard');
    expect(jumpLinkFor([{ name: 'listLowStock', ok: false }])).toBeNull();
    expect(jumpLinkFor(undefined)).toBeNull();
  });
});

describe('ChatPanel', () => {
  it('opens on the suggestions, with the tour anchor and named composer controls', async () => {
    mockFetch({ stored: false });
    render(<ChatPanel />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Ask your inventory anything' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "What's below reorder right now?" })).toBeEnabled();
    // The AI tour's third step targets this accessible name.
    expect(screen.getByLabelText('Ask the inventory assistant').tagName).toBe('TEXTAREA');
    expect(screen.getByRole('button', { name: 'Attach a file with ISBNs' })).toBeInTheDocument();
    // The icon-only send button had no accessible name.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await screen.findByText('Low stock check');
    // Nothing to clear yet, so the phone bar's New chat is not drawn.
    expect(screen.getAllByRole('button', { name: 'New chat' })).toHaveLength(1);
  });

  it('restores the stored chat: plain text, tool chips, Confirm / Cancel and the fixed jump link', async () => {
    mockFetch({ stored: true });
    render(<ChatPanel />);
    // Plain text: markup in a reply is shown as typed, never parsed.
    expect(await screen.findByText('Three items are low. <b>not bold</b>')).toBeInTheDocument();
    expect(screen.getByText('listLowStock')).toBeInTheDocument();
    expect(screen.getByText('searchInventory').closest('[data-ok]')).toHaveAttribute(
      'data-ok',
      'false',
    );
    // The last turn ends "Confirm?": Confirm and Cancel, and no jump link on it.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open movements log/ })).toBeNull();
    // The earlier turn's jump link opens the filtered low-stock list.
    expect(screen.getByRole('link', { name: 'Open low-stock list →' })).toHaveAttribute(
      'href',
      '/dashboard/inventory?stock=low&type=all',
    );
    // The active chat is marked in the rail.
    expect(screen.getByRole('button', { name: /Low stock check/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('keeps Delete chat reachable from the keyboard and on touch, not only on hover (D18)', async () => {
    mockFetch({ stored: false });
    render(<ChatPanel />);
    const del = await screen.findByRole('button', { name: 'Delete chat' });
    // Hidden at rest for a mouse, shown on row hover, on its own focus and
    // whenever the pointer is coarse.
    expect(del.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(del.className).toContain('group-hover:opacity-100');
    expect(del.className).toContain('focus-visible:opacity-100');
    expect(del.className).toContain('pointer-coarse:opacity-100');
  });

  it('offers New chat beside the conversation below md, and it starts a fresh chat', async () => {
    mockFetch({ stored: true });
    const { container } = render(<ChatPanel />);
    await screen.findByText('Three items are low. <b>not bold</b>');
    const bar = container.querySelector('[data-slot="chat-phone-bar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.className).toContain('md:hidden');
    fireEvent.click(within(bar).getByRole('button', { name: 'New chat' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ask your inventory anything' })).toBeVisible(),
    );
    expect(window.localStorage.getItem('stockpilot.ai.activeSession')).toBeNull();
  });
});
