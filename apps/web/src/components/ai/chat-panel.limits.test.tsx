import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';

import { CHAT_MESSAGE_TOO_LONG } from '@/lib/ai/chat-limits';
import { syntheticIsbn13s } from '@/test/synthetic-isbns';

import { ChatPanel } from './chat-panel';

/**
 * The web AI Assistant's limits, checked before anything is shown or sent
 * (docket B76).
 *
 * An attached file's ISBNs were sent as one chat message whatever their
 * number. The assistant previews and imports at most 50 per call, so from 51
 * the chat turn was spent for nothing, and from about 130 the route refused
 * the message (over 2,000 characters) after the whole list had been shown as
 * the person's message. A typed message over 2,000 characters was shown, the
 * box cleared, and then refused. Now the panel sends the extraction its cap,
 * and a list over 50, or a typed message over 2,000 characters, is not sent:
 * a note above the message box says why, and for a list, where to go
 * instead. A file of 50 or fewer is sent as before, and keeps what the
 * person had typed in the box.
 *
 * A fake server answers every request the panel makes: the extraction reads
 * the ISBNs from the attached file's own text (each line of 13 digits), and
 * the chat answers with a short stream.
 */

const PAST_CHAT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Earlier chat',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
};
const PAST_MESSAGES = [
  { role: 'user', content: 'Which shelf is low?', toolCalls: null },
  { role: 'assistant', content: 'Two shelves are low.', toolCalls: null },
];
const NEW_CHAT = '11111111-1111-4111-8111-111111111111';
const REPLY = 'Here is the preview.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeServer() {
  const requests: string[] = [];
  const extractForms: FormData[] = [];
  const chatMessages: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/ai/sessions' && method === 'GET') {
      return json({ ok: true, sessions: [PAST_CHAT] });
    }
    if (url === `/api/ai/sessions/${PAST_CHAT.id}` && method === 'GET') {
      return json({ ok: true, messages: PAST_MESSAGES });
    }
    if (url === '/api/books/extract-isbns-ai') {
      const form = init!.body as FormData;
      extractForms.push(form);
      const text = await (form.get('file') as File).text();
      const isbns = text.split('\n').filter((line) => /^[0-9]{13}$/.test(line));
      return json({ ok: true, isbns, notes: `${isbns.length} regex hits` });
    }
    if (url === '/api/ai/chat') {
      chatMessages.push((JSON.parse(String(init!.body)) as { message: string }).message);
      const lines = [
        { type: 'text', delta: REPLY },
        { type: 'done', sessionId: NEW_CHAT, reply: REPLY, toolCallsUsed: [] },
      ];
      return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    extractForms,
    chatMessages,
    count: (request: string) => requests.filter((r) => r === request).length,
  };
}

const messageBox = () => screen.getByRole('textbox', { name: 'Ask the inventory assistant' });
const conversation = () => document.querySelector('[aria-live="polite"]') as HTMLElement;
const rail = () => document.querySelector('aside') as HTMLElement;
const note = () => screen.queryByRole('alert');

/** Attaches a file whose text is these lines (ISBNs, one per line). */
function attach(lines: string[], name = 'order-sheet.csv') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([lines.join('\n')], name, { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
}
function typeAndPressEnter(text: string) {
  fireEvent.change(messageBox(), { target: { value: text } });
  fireEvent.keyDown(messageBox(), { key: 'Enter' });
}
/** The reply to the last message has arrived and the box is open again. */
async function replied() {
  await screen.findByText(REPLY);
  await waitFor(() => expect(messageBox()).toBeEnabled());
}
async function opened() {
  await within(rail()).findByText(PAST_CHAT.title);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  // happy-dom has no scrollTo on elements.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatPanel limits (B76)', () => {
  it('a file with 51 ISBNs is not sent: a note with the count links to Bulk ISBN import (3)', async () => {
    const server = fakeServer();
    const isbns = syntheticIsbn13s(51);
    render(<ChatPanel canOpenBulkIsbnImport />);
    await opened();
    attach(isbns);
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText(
        'Found 51 ISBNs in this file. The assistant adds up to 50 at a time, so use Bulk ISBN import for this list.',
      ),
    ).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'Open Bulk ISBN import' })).toHaveAttribute(
      'href',
      '/dashboard/books/import',
    );
    await waitFor(() => expect(messageBox()).not.toHaveAttribute('placeholder', 'Reading file…'));
    // Nothing was sent or shown as the person's message, and no toast.
    expect(server.count('POST /api/ai/chat')).toBe(0);
    expect(conversation().textContent).not.toContain(isbns[0]);
    expect(conversation().querySelector('[data-role="user"]')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('sends the extraction the cap, so it can skip AI work past it (4)', async () => {
    const server = fakeServer();
    render(<ChatPanel canOpenBulkIsbnImport />);
    await opened();
    attach(syntheticIsbn13s(2));
    await waitFor(() => expect(server.extractForms).toHaveLength(1));
    expect(server.extractForms[0]!.get('maxIsbns')).toBe('50');
  });

  it('without Bulk ISBN import, the note asks for a smaller file and has no link (5)', async () => {
    fakeServer();
    render(<ChatPanel />);
    await opened();
    attach(syntheticIsbn13s(51));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Found 51 ISBNs in this file. The assistant adds up to 50 at a time, so attach a file with 50 or fewer.',
    );
    expect(within(alert).queryByRole('link')).toBeNull();
  });

  it('a typed message over 2,000 characters stays in the box with the note, and is not sent (6)', async () => {
    const server = fakeServer();
    render(<ChatPanel />);
    await opened();
    const long = 'x'.repeat(2001);
    typeAndPressEnter(long);
    expect(await screen.findByRole('alert')).toHaveTextContent(CHAT_MESSAGE_TOO_LONG);
    expect(CHAT_MESSAGE_TOO_LONG).toBe(
      'Your message is too long. Keep it to 2,000 characters or fewer.',
    );
    expect(messageBox()).toHaveValue(long);
    expect(server.count('POST /api/ai/chat')).toBe(0);
    expect(conversation().querySelector('[data-role="user"]')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  describe('the note clears (7)', () => {
    async function withNote() {
      const server = fakeServer();
      render(<ChatPanel canOpenBulkIsbnImport />);
      await opened();
      typeAndPressEnter('x'.repeat(2001));
      expect(await screen.findByRole('alert')).toHaveTextContent(CHAT_MESSAGE_TOO_LONG);
      return server;
    }

    it('on the next upload, whatever the file holds', async () => {
      // A file with no ISBNs is never sent, so only the upload itself can
      // have cleared the note.
      const server = await withNote();
      attach(['Order sheet', 'Titles to be confirmed'], 'notes.csv');
      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith('No ISBNs found in "notes.csv".'),
      );
      expect(note()).toBeNull();
      expect(server.count('POST /api/ai/chat')).toBe(0);
    });

    it('on the next message sent', async () => {
      await withNote();
      typeAndPressEnter('Which shelf is low?');
      await waitFor(() => expect(note()).toBeNull());
      await replied();
    });

    it('on New chat', async () => {
      await withNote();
      fireEvent.click(within(rail()).getByRole('button', { name: 'New chat' }));
      await waitFor(() => expect(note()).toBeNull());
    });

    it('on picking another chat in the rail', async () => {
      await withNote();
      fireEvent.click(within(rail()).getByRole('button', { name: /Earlier chat/ }));
      await screen.findByText('Two shelves are low.');
      expect(note()).toBeNull();
    });
  });

  it('keeps what the person typed in the box when a file of 50 or fewer is sent (8)', async () => {
    const server = fakeServer();
    render(<ChatPanel canOpenBulkIsbnImport />);
    await opened();
    fireEvent.change(messageBox(), { target: { value: 'Put them in the main warehouse.' } });
    attach(syntheticIsbn13s(2));
    await replied();
    expect(server.chatMessages).toHaveLength(1);
    expect(server.chatMessages[0]).toMatch(/^\[Uploaded order-sheet\.csv/);
    expect(messageBox()).toHaveValue('Put them in the main warehouse.');
  });

  it('sends a file of exactly 50 ISBNs, and a typed message of exactly 2,000 characters, as before (16)', async () => {
    const server = fakeServer();
    const isbns = syntheticIsbn13s(50);
    render(<ChatPanel canOpenBulkIsbnImport />);
    await opened();
    attach(isbns);
    await replied();
    expect(server.count('POST /api/ai/chat')).toBe(1);
    const sent = server.chatMessages[0]!;
    expect(sent.startsWith('[Uploaded order-sheet.csv — extracted 50 ISBNs')).toBe(true);
    expect(sent.split('\n').slice(2, 52)).toEqual(isbns);
    expect(note()).toBeNull();

    const exact = 'y'.repeat(2000);
    typeAndPressEnter(exact);
    await waitFor(() => expect(server.chatMessages).toHaveLength(2));
    expect(server.chatMessages[1]).toBe(exact);
    expect(note()).toBeNull();
  });
});
