import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';

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
    content: 'I will remove 2 from Sample Mug. Confirm?',
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
    // Every organization sees these chips, so they name no real brand (S17).
    expect(screen.getByRole('button', { name: 'Find water bottles.' })).toBeEnabled();
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

/**
 * B84: changing chats while an answer is still arriving. send() wrote the rest
 * of an answer into whatever turn was last on screen and bound the chat its
 * `done` named to the screen, so after New chat, or after opening another
 * chat, the next message was filed in the first chat. A chat that finished
 * loading (the one restored on page open, or a click in the rail) replaced
 * whatever the person had done since, and a file's ISBNs went into whichever
 * chat was on screen when the read ended.
 *
 * A fake server answers every request the panel makes. /api/ai/chat answers
 * with a stream the test feeds a line at a time, in the route's order: a first
 * `session` line (the panel ignores it), then text, tool and error lines, and
 * `done` last. Any request can be held, then released, to order it. Real
 * timers only: fake timers and React's scheduler do not mix.
 */

const ACTIVE_CHAT_ITEM = 'stockpilot.ai.activeSession';
const CHAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// The chats the fake route starts, in order, for messages sent with no chat.
const NEW_CHATS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const FIRST_NEW_CHAT = NEW_CHATS[0];
const SUGGESTION = "What's below reorder right now?";
const ISBNS = ['9780306406157', '9780000000002'];
const NOT_SENT =
  'The ISBNs from "isbn-list.csv" were not sent because you changed chats while the file was being read. Attach it again.';
const LISTED_AT = '2026-10-20T10:00:00Z';

type StoredTurn = {
  role: 'user' | 'assistant';
  content: string;
  toolCalls: Array<{ name: string; ok: boolean }> | null;
};

const PAST_CHATS: Record<string, { title: string; messages: StoredTurn[] }> = {
  [CHAT_A]: {
    title: 'Chat A',
    messages: [
      { role: 'user', content: 'Which shelf is low?', toolCalls: null },
      {
        role: 'assistant',
        content: 'Two shelves are low.',
        toolCalls: [{ name: 'listWarehouses', ok: true }],
      },
    ],
  },
  [CHAT_B]: {
    title: 'Chat B',
    messages: [
      { role: 'user', content: 'Show recent receipts.', toolCalls: null },
      {
        role: 'assistant',
        content: 'Two receipts came in this week.',
        toolCalls: [{ name: 'getMovements', ok: true }],
      },
    ],
  },
  // Its last reply asks for a confirmation, so Confirm and Cancel show.
  [CHAT_C]: {
    title: 'Chat C',
    messages: [
      { role: 'user', content: 'Take two sample mugs out.', toolCalls: null },
      {
        role: 'assistant',
        content: 'I will remove 2 from Sample Mug. Confirm?',
        toolCalls: [{ name: 'searchInventory', ok: true }],
      },
    ],
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One answer from /api/ai/chat, fed a line at a time by the test. */
function answerStream(sessionId: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const line = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  line({ type: 'session', id: sessionId });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    }),
    text: (delta: string) => line({ type: 'text', delta }),
    tool: (name: string) => line({ type: 'tool', name, ok: true }),
    error: (message: string) => line({ type: 'error', code: 'unknown', message }),
    done: () => {
      line({ type: 'done', sessionId, reply: '', toolCallsUsed: [] });
      controller.close();
    },
    /** The connection drops mid-answer: the browser's read rejects. */
    cut: () => controller.error(new TypeError('network error')),
  };
}

type ChatAnswer = 'stream' | 'no answer' | { status: number; message: string };

/**
 * Stubs fetch with the panel's server. `hold` names requests that wait for
 * release(name): a chat's id (its read), `reread:<id>` (that chat's later
 * reads, answered with the chat as it was when asked, as a read the server
 * finished before a delete but that arrives after it), `delete:<id>`,
 * `extract` (the file read) or `chat` (every message). `gone` chats are listed
 * but answer 404, as a chat deleted elsewhere does; `noAnswer` reads fail as a
 * dropped connection does. `chatAnswers` says how each message is answered (a
 * stream if unset).
 */
function fakeServer({
  chats = [CHAT_B],
  holdList = false,
  hold = [],
  gone = [],
  noAnswer = [],
  chatAnswers = [],
}: {
  chats?: string[];
  holdList?: boolean;
  hold?: string[];
  gone?: string[];
  noAnswer?: string[];
  chatAnswers?: ChatAnswer[];
} = {}) {
  const stored = new Map(chats.map((id) => [id, structuredClone(PAST_CHATS[id]!)]));
  const gates = new Map(hold.map((name) => [name, deferred()]));
  const listGate = holdList ? deferred() : null;
  let listReads = 0;
  const chatReads = new Map<string, number>();
  const newChats = [...NEW_CHATS];
  const requests: string[] = [];
  const chatBodies: Array<{ message: string; sessionId?: string }> = [];
  const streams: Array<ReturnType<typeof answerStream>> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url === '/api/ai/sessions' && method === 'GET') {
      listReads += 1;
      if (listReads === 1) await listGate?.promise;
      return json({
        ok: true,
        sessions: Array.from(stored, ([id, chat]) => ({
          id,
          title: chat.title,
          createdAt: LISTED_AT,
          updatedAt: LISTED_AT,
        })),
      });
    }
    const chatId = /^\/api\/ai\/sessions\/([0-9a-f-]{36})$/.exec(url)?.[1];
    if (chatId && method === 'GET') {
      const read = (chatReads.get(chatId) ?? 0) + 1;
      chatReads.set(chatId, read);
      const answer = () => {
        if (noAnswer.includes(chatId)) throw new TypeError('Failed to fetch');
        const chat = gone.includes(chatId) ? undefined : stored.get(chatId);
        return chat
          ? json({ ok: true, messages: chat.messages })
          : json({ error: 'not_found' }, 404);
      };
      const reread = read > 1 ? gates.get(`reread:${chatId}`) : undefined;
      if (reread) {
        const reply = answer();
        await reread.promise;
        return reply;
      }
      await gates.get(chatId)?.promise;
      return answer();
    }
    if (chatId && method === 'DELETE') {
      await gates.get(`delete:${chatId}`)?.promise;
      stored.delete(chatId);
      return json({ ok: true });
    }
    if (url === '/api/books/extract-isbns-ai') {
      await gates.get('extract')?.promise;
      return json({ ok: true, isbns: ISBNS });
    }
    if (url === '/api/ai/chat') {
      const body = JSON.parse(String(init?.body)) as { message: string; sessionId?: string };
      const answer = chatAnswers[chatBodies.length] ?? 'stream';
      chatBodies.push(body);
      await gates.get('chat')?.promise;
      if (answer === 'no answer') throw new TypeError('Failed to fetch');
      // A refusal comes before the route saves anything.
      if (answer !== 'stream') {
        return json({ error: 'refused', message: answer.message }, answer.status);
      }
      // As the route does: a chat it cannot find starts a new one, and the
      // question is saved before the answer streams.
      const id = body.sessionId && stored.has(body.sessionId) ? body.sessionId : newChats.shift()!;
      if (!stored.has(id)) stored.set(id, { title: body.message, messages: [] });
      stored.get(id)!.messages.push({ role: 'user', content: body.message, toolCalls: null });
      const stream = answerStream(id);
      streams.push(stream);
      return stream.response;
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    chatBodies,
    streams,
    release: (name: string) => gates.get(name)!.resolve(),
    releaseList: () => listGate!.resolve(),
    /** How many times a request was made, e.g. `GET /api/ai/sessions`. */
    count: (request: string) => requests.filter((r) => r === request).length,
  };
}

const rail = () => document.querySelector('aside') as HTMLElement;
// The conversation: its turns, or the suggestions while the chat is empty.
const conversation = () => document.querySelector('[aria-live="polite"]') as HTMLElement;
const messageBox = () => screen.getByRole('textbox', { name: 'Ask the inventory assistant' });
const emptyChat = () => screen.queryByRole('heading', { name: 'Ask your inventory anything' });
const userTurns = () =>
  Array.from(conversation().querySelectorAll('[data-role="user"]'), (turn) => turn.textContent);
/** A chat's row in the rail, by its title. */
const railRow = (title: string) =>
  within(rail()).getByRole('button', { name: (name) => name.startsWith(title) });
const openChat = (title: string) => fireEvent.click(railRow(title));
const deleteChat = (title: string) =>
  fireEvent.click(
    within(railRow(title).closest('li') as HTMLElement).getByRole('button', {
      name: 'Delete chat',
    }),
  );
/** New chat in the rail (md and wider), or in the bar above the chat (below md). */
function pressNewChat(where: 'rail' | 'phone bar' = 'rail') {
  const place =
    where === 'rail'
      ? rail()
      : (document.querySelector('[data-slot="chat-phone-bar"]') as HTMLElement);
  fireEvent.click(within(place).getByRole('button', { name: 'New chat' }));
}
function typeAndSend(message: string) {
  fireEvent.change(messageBox(), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}
function attachFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([ISBNS.join('\n')], 'isbn-list.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
}
/** The stream answering the n-th message sent (from 1), once the route has it. */
async function answerTo(server: ReturnType<typeof fakeServer>, n: number) {
  await waitFor(() => expect(server.streams).toHaveLength(n));
  return server.streams[n - 1]!;
}
/** The answer in flight has ended: the message box opens again. */
const answerEnded = () => waitFor(() => expect(messageBox()).toBeEnabled());
const fileReadEnded = () =>
  waitFor(() => expect(messageBox()).not.toHaveAttribute('placeholder', 'Reading file…'));
/** Lets a released request, and everything it sets off, run to the end. */
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 3; turn += 1) await new Promise((next) => setTimeout(next, 0));
  });

describe('ChatPanel while an answer is arriving (B84)', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  describe('changing chats during an answer', () => {
    it('an answer nobody interrupts binds its new chat, as before (S0)', async () => {
      const server = fakeServer();
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => {
        answer.text('Three items ');
        answer.tool('listLowStock');
        answer.text('are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(screen.getByText('Three items are below reorder.')).toBeInTheDocument();
      expect(screen.getByText('listLowStock')).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(FIRST_NEW_CHAT);
      // The rail is read again and marks the new chat.
      await waitFor(() => expect(railRow(SUGGESTION)).toHaveAttribute('aria-current', 'true'));
      expect(server.count('GET /api/ai/sessions')).toBe(2);
      typeAndSend('And in the second warehouse?');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBe(FIRST_NEW_CHAT);
    });

    it.each(['rail', 'phone bar'] as const)(
      'New chat in the %s keeps the rest of a first answer out of the new chat, and the next message starts a chat of its own (R1)',
      async (where) => {
        const server = fakeServer();
        render(<ChatPanel />);
        await within(rail()).findByText('Chat B');
        fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
        const answer = await answerTo(server, 1);
        await act(async () => answer.text('Three items '));
        await screen.findByText('Three items');
        pressNewChat(where);
        await act(async () => {
          answer.tool('listLowStock');
          answer.text('are below reorder.');
          answer.done();
        });
        await answerEnded();
        expect(emptyChat()).toBeInTheDocument();
        expect(screen.queryByText(/are below reorder/)).toBeNull();
        expect(screen.queryByText('listLowStock')).toBeNull();
        expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
        // The chat left behind is listed once its answer ends, and is not marked open.
        await waitFor(() => expect(railRow(SUGGESTION)).toBeInTheDocument());
        expect(rail().querySelector('[aria-current]')).toBeNull();
        typeAndSend('List warehouses we operate.');
        await waitFor(() => expect(server.chatBodies).toHaveLength(2));
        expect(server.chatBodies[1]!.sessionId).toBeUndefined();
      },
    );

    it('New chat during an answer in a chat that has a session leaves a new chat, as before (C1)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      typeAndSend('Which aisle is that shelf in?');
      const answer = await answerTo(server, 1);
      expect(server.chatBodies[0]!.sessionId).toBe(CHAT_A);
      pressNewChat();
      await act(async () => {
        answer.text('Aisle three.');
        answer.done();
      });
      await answerEnded();
      expect(emptyChat()).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
      typeAndSend('List warehouses we operate.');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBeUndefined();
    });

    it('New chat, then the answer fails: no error reply and no toast in the new chat (R4)', async () => {
      const server = fakeServer();
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      pressNewChat();
      await act(async () => {
        answer.error('The assistant could not finish that answer.');
        answer.done();
      });
      await answerEnded();
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText('The assistant could not finish that answer.')).toBeNull();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('a chat left while its first answer fails is listed once the answer ends (R4b)', async () => {
      const server = fakeServer();
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      pressNewChat();
      await act(async () => {
        answer.error('The assistant could not finish that answer.');
        answer.done();
      });
      await answerEnded();
      // Its question is saved in that chat, so the rail is read again to list it.
      await waitFor(() => expect(server.count('GET /api/ai/sessions')).toBe(2));
      await waitFor(() => expect(railRow(SUGGESTION)).toBeInTheDocument());
    });

    it.each(['New chat', 'another chat opened'] as const)(
      '%s, then the answer is cut off: nothing is said on screen, and the chat left is listed (R4c)',
      async (change) => {
        const server = fakeServer();
        render(<ChatPanel />);
        await within(rail()).findByText('Chat B');
        fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
        const answer = await answerTo(server, 1);
        await act(async () => answer.text('Three items '));
        await screen.findByText('Three items');
        if (change === 'New chat') {
          pressNewChat();
        } else {
          openChat('Chat B');
          await screen.findByText('Two receipts came in this week.');
        }
        await act(async () => answer.cut());
        await answerEnded();
        expect(toast.error).not.toHaveBeenCalled();
        // The route saved its question before it answered, so the rail is read
        // again to list the chat left.
        await waitFor(() => expect(server.count('GET /api/ai/sessions')).toBe(2));
        await waitFor(() => expect(railRow(SUGGESTION)).toBeInTheDocument());
        if (change === 'New chat') {
          expect(emptyChat()).toBeInTheDocument();
        } else {
          expect(userTurns()).toEqual(['Show recent receipts.']);
          expect(railRow('Chat B')).toHaveAttribute('aria-current', 'true');
        }
      },
    );

    it('an answer cut off in the chat on screen is still said there, as before (R4d)', async () => {
      const server = fakeServer();
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => answer.text('Three items '));
      await screen.findByText('Three items');
      await act(async () => answer.cut());
      await answerEnded();
      expect(toast.error).toHaveBeenCalledTimes(1);
      // The same words take the answer's place.
      const said = String(vi.mocked(toast.error).mock.calls[0]![0]);
      expect(within(conversation()).getByText(said)).toBeInTheDocument();
      expect(userTurns()).toEqual([SUGGESTION]);
    });

    it('New chat, then an answer with tool calls and no text: no fallback reply in the new chat (R5)', async () => {
      const server = fakeServer();
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      pressNewChat();
      await act(async () => {
        answer.tool('listLowStock');
        answer.done();
      });
      await answerEnded();
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText(/I ran the lookups for that/)).toBeNull();
    });

    it('a past chat opened during the answer keeps its own last reply, and the next message goes to it (R2)', async () => {
      const server = fakeServer({ chats: [CHAT_A, CHAT_B] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => answer.text('Three items '));
      await screen.findByText('Three items');
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => {
        answer.tool('listLowStock');
        answer.text('are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(userTurns()).toEqual(['Show recent receipts.']);
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
      expect(screen.getByText('getMovements')).toBeInTheDocument();
      expect(screen.queryByText('listLowStock')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_B);
      expect(railRow('Chat B')).toHaveAttribute('aria-current', 'true');
      typeAndSend('Which supplier sent them?');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBe(CHAT_B);
    });

    it('in a chat with a session, an answer asking to confirm stays out of a chat opened meanwhile (R3)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      typeAndSend('Take two sample mugs out.');
      const answer = await answerTo(server, 1);
      expect(server.chatBodies[0]!.sessionId).toBe(CHAT_A);
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => {
        answer.tool('adjustStock');
        answer.text('I will remove 2 from Sample Mug. Confirm?');
        answer.done();
      });
      await answerEnded();
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
      expect(screen.queryByText('adjustStock')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_B);
    });

    it('in a chat with a session, a failed answer shows no toast and leaves a chat opened meanwhile as it is (R6)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      typeAndSend('Take two sample mugs out.');
      const answer = await answerTo(server, 1);
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => {
        answer.error('The assistant could not finish that answer.');
        answer.done();
      });
      await answerEnded();
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
      expect(screen.queryByText('The assistant could not finish that answer.')).toBeNull();
    });

    it('a past chat deleted elsewhere, opened during a first answer, leaves a new chat the answer stays out of (R7)', async () => {
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], gone: [CHAT_A] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat A');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => answer.text('Three items '));
      await screen.findByText('Three items');
      openChat('Chat A');
      await waitFor(() => expect(emptyChat()).toBeInTheDocument());
      await act(async () => {
        answer.tool('listLowStock');
        answer.text('are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText(/are below reorder/)).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
      typeAndSend('List warehouses we operate.');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBeUndefined();
    });
  });

  describe('a message refused, or with no answer, after a chat change', () => {
    it('a refusal after New chat is still said, and nothing lands in the new chat (P1)', async () => {
      const refusal = 'Too many AI chat requests. Slow down for a moment.';
      const server = fakeServer({
        hold: ['chat'],
        chatAnswers: [{ status: 429, message: refusal }],
      });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      pressNewChat();
      await act(async () => server.release('chat'));
      await answerEnded();
      // The route refused it before saving it: it is in no chat, so it is said.
      expect(toast.error).toHaveBeenCalledWith(refusal);
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText(refusal)).toBeNull();
    });

    it('a refusal after opening another chat is still said, and that chat is left as it is (P2)', async () => {
      const server = fakeServer({
        hold: ['chat'],
        chatAnswers: [{ status: 500, message: 'Could not save your message.' }],
      });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => server.release('chat'));
      await answerEnded();
      expect(toast.error).toHaveBeenCalledWith('Could not save your message.');
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
      expect(screen.getByText('getMovements')).toBeInTheDocument();
    });

    it('a message that gets no answer after New chat is still said, and nothing lands in the new chat (P3)', async () => {
      const server = fakeServer({ hold: ['chat'], chatAnswers: ['no answer'] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      pressNewChat();
      await act(async () => server.release('chat'));
      await answerEnded();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(emptyChat()).toBeInTheDocument();
    });
  });

  describe('a chat still loading', () => {
    it('a suggestion pressed while the chat open last time loads stays on screen, with its whole answer (M1)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A] });
      render(<ChatPanel />);
      await waitFor(() => expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(1));
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => answer.text('Three items '));
      await act(async () => server.release(CHAT_A));
      await settle();
      await act(async () => {
        answer.tool('listLowStock');
        answer.text('are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(userTurns()).toEqual([SUGGESTION]);
      expect(screen.getByText('Three items are below reorder.')).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(FIRST_NEW_CHAT);
      typeAndSend('And in the second warehouse?');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBe(FIRST_NEW_CHAT);
    });

    it('a suggestion pressed while the past chats load stays on screen, with its whole answer (M1b)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], holdList: true });
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => answer.text('Three items '));
      await act(async () => server.releaseList());
      await within(rail()).findByText('Chat B');
      await settle();
      await act(async () => {
        answer.tool('listLowStock');
        answer.text('are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(userTurns()).toEqual([SUGGESTION]);
      expect(screen.getByText('Three items are below reorder.')).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(FIRST_NEW_CHAT);
      typeAndSend('And in the second warehouse?');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBe(FIRST_NEW_CHAT);
    });

    it('New chat pressed while the chat open last time loads stays a new chat (M2)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A] });
      render(<ChatPanel />);
      await waitFor(() => expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(1));
      pressNewChat();
      await act(async () => server.release(CHAT_A));
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText('Which shelf is low?')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it('New chat pressed while the past chats load stays a new chat, as before (M2b)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], holdList: true });
      render(<ChatPanel />);
      pressNewChat();
      await act(async () => server.releaseList());
      await within(rail()).findByText('Chat B');
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(0);
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it('a file attached while the chat open last time loads is sent in a chat of its own, with no warning (M3)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A, 'extract'] });
      render(<ChatPanel />);
      await waitFor(() => expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(1));
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      await act(async () => server.release(CHAT_A));
      await settle();
      await act(async () => server.release('extract'));
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      expect(server.chatBodies[0]!.sessionId).toBeUndefined();
      await waitFor(() => expect(userTurns().join('\n')).toContain('[Uploaded isbn-list.csv'));
      expect(userTurns()).toHaveLength(1);
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('a file attached while the past chats load is sent in a chat of its own, with no warning (M3b)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], holdList: true, hold: ['extract'] });
      render(<ChatPanel />);
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      await act(async () => server.releaseList());
      await within(rail()).findByText('Chat B');
      await settle();
      await act(async () => server.release('extract'));
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      expect(server.chatBodies[0]!.sessionId).toBeUndefined();
      await waitFor(() => expect(userTurns().join('\n')).toContain('[Uploaded isbn-list.csv'));
      expect(userTurns()).toHaveLength(1);
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('the chat open last time failing to load after a suggestion was pressed shows no toast (K1)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A], noAnswer: [CHAT_A] });
      render(<ChatPanel />);
      await waitFor(() => expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(1));
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => server.release(CHAT_A));
      await settle();
      await act(async () => {
        answer.text('Three items are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(toast.error).not.toHaveBeenCalled();
      expect(userTurns()).toEqual([SUGGESTION]);
    });

    it('of two chats opened from the rail, the one clicked last stays, whichever loads last (G1)', async () => {
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      openChat('Chat A');
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => server.release(CHAT_A));
      await settle();
      expect(screen.queryByText('Two shelves are low.')).toBeNull();
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
      expect(railRow('Chat B')).toHaveAttribute('aria-current', 'true');
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_B);
    });

    it('New chat pressed while a chat opened from the rail loads stays a new chat (G2)', async () => {
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat A');
      openChat('Chat A');
      pressNewChat();
      await act(async () => server.release(CHAT_A));
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText('Two shelves are low.')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it('a chat clicked first that fails to load after a later one opened shows no toast (K2)', async () => {
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_A], noAnswer: [CHAT_A] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      openChat('Chat A');
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => server.release(CHAT_A));
      await settle();
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
    });

    it('Confirm pressed while a chat opened from the rail loads: the chat confirmed in stays, with its answer (RC1)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_C);
      const server = fakeServer({ chats: [CHAT_C, CHAT_B], hold: [CHAT_B] });
      render(<ChatPanel />);
      const confirm = await screen.findByRole('button', { name: 'Confirm' });
      openChat('Chat B');
      fireEvent.click(confirm);
      const answer = await answerTo(server, 1);
      expect(server.chatBodies[0]).toMatchObject({ message: 'yes, confirm', sessionId: CHAT_C });
      await act(async () => server.release(CHAT_B));
      await settle();
      await act(async () => {
        answer.text('Removed 2 from Sample Mug.');
        answer.done();
      });
      await answerEnded();
      expect(userTurns()).toEqual(['Take two sample mugs out.', 'yes, confirm']);
      expect(screen.getByText('Removed 2 from Sample Mug.')).toBeInTheDocument();
      expect(screen.queryByText('Two receipts came in this week.')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_C);
      typeAndSend('That is all for now.');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBe(CHAT_C);
    });

    it('a chat opened from the rail that loads after the answer ended opens, as before (R2b)', async () => {
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [CHAT_B] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      openChat('Chat B');
      await act(async () => {
        answer.text('Three items are below reorder.');
        answer.done();
      });
      await answerEnded();
      expect(screen.getByText('Three items are below reorder.')).toBeInTheDocument();
      await act(async () => server.release(CHAT_B));
      await screen.findByText('Two receipts came in this week.');
      expect(railRow('Chat B')).toHaveAttribute('aria-current', 'true');
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_B);
      typeAndSend('Which supplier sent them?');
      await waitFor(() => expect(server.chatBodies).toHaveLength(2));
      expect(server.chatBodies[1]!.sessionId).toBe(CHAT_B);
    });
  });

  describe('deleting a chat', () => {
    it('deleting the open chat, then opening another before the delete answers, keeps the one opened (H1)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [`delete:${CHAT_A}`] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      deleteChat('Chat A');
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => server.release(`delete:${CHAT_A}`));
      await waitFor(() => expect(within(rail()).queryByText('Chat A')).toBeNull());
      await settle();
      expect(screen.getByText('Two receipts came in this week.')).toBeInTheDocument();
      expect(railRow('Chat B')).toHaveAttribute('aria-current', 'true');
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_B);
    });

    it('deleting the open chat, then opening another that loads after the delete, opens it, as before (H2)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({
        chats: [CHAT_A, CHAT_B],
        hold: [`delete:${CHAT_A}`, CHAT_B],
      });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      deleteChat('Chat A');
      openChat('Chat B');
      await act(async () => server.release(`delete:${CHAT_A}`));
      await waitFor(() => expect(emptyChat()).toBeInTheDocument());
      await act(async () => server.release(CHAT_B));
      await screen.findByText('Two receipts came in this week.');
      expect(railRow('Chat B')).toHaveAttribute('aria-current', 'true');
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(CHAT_B);
    });

    it('deleting the open chat opens a new chat, as before (H3)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      fakeServer({ chats: [CHAT_A, CHAT_B] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      deleteChat('Chat A');
      await waitFor(() => expect(emptyChat()).toBeInTheDocument());
      expect(within(rail()).queryByText('Chat A')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it('deleting the open chat, then opening it again before the delete answers, leaves a new chat (H4)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [`delete:${CHAT_A}`] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      deleteChat('Chat A');
      openChat('Chat A');
      await waitFor(() => expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(2));
      await settle();
      await act(async () => server.release(`delete:${CHAT_A}`));
      await waitFor(() => expect(within(rail()).queryByText('Chat A')).toBeNull());
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
      expect(rail().querySelector('[aria-current]')).toBeNull();
      typeAndSend('List warehouses we operate.');
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      expect(server.chatBodies[0]!.sessionId).toBeUndefined();
    });

    it('opening the open chat again, then deleting it, the read landing first, leaves a new chat (H5)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({
        chats: [CHAT_A, CHAT_B],
        hold: [`reread:${CHAT_A}`, `delete:${CHAT_A}`],
      });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      openChat('Chat A');
      deleteChat('Chat A');
      await act(async () => server.release(`reread:${CHAT_A}`));
      await settle();
      await act(async () => server.release(`delete:${CHAT_A}`));
      await waitFor(() => expect(within(rail()).queryByText('Chat A')).toBeNull());
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it('deleting another chat, then opening it before the delete answers, leaves a new chat (H6)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: [`delete:${CHAT_B}`] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      deleteChat('Chat B');
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => server.release(`delete:${CHAT_B}`));
      await waitFor(() => expect(within(rail()).queryByText('Chat B')).toBeNull());
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it('a read of the open chat that arrives after its delete leaves the new chat (H7)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({
        chats: [CHAT_A, CHAT_B],
        hold: [`reread:${CHAT_A}`, `delete:${CHAT_A}`],
      });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      // The read is answered before the delete runs, but arrives after it.
      openChat('Chat A');
      deleteChat('Chat A');
      await waitFor(() => expect(server.count(`GET /api/ai/sessions/${CHAT_A}`)).toBe(2));
      await act(async () => server.release(`delete:${CHAT_A}`));
      await waitFor(() => expect(emptyChat()).toBeInTheDocument());
      await act(async () => server.release(`reread:${CHAT_A}`));
      await settle();
      expect(emptyChat()).toBeInTheDocument();
      expect(screen.queryByText('Two shelves are low.')).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
    });

    it.each(['New chat', 'a chat deleted elsewhere opened'] as const)(
      'after %s, deleting the chat left there leaves the screen and the answer arriving as they are (H8)',
      async (change) => {
        window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
        const server = fakeServer({ chats: [CHAT_A, CHAT_B], gone: [CHAT_B] });
        render(<ChatPanel />);
        await screen.findByText('Two shelves are low.');
        if (change === 'New chat') pressNewChat();
        else openChat('Chat B');
        await waitFor(() => expect(emptyChat()).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
        const answer = await answerTo(server, 1);
        await act(async () => answer.text('Three items '));
        deleteChat('Chat A');
        await waitFor(() => expect(within(rail()).queryByText('Chat A')).toBeNull());
        await act(async () => {
          answer.text('are below reorder.');
          answer.done();
        });
        await answerEnded();
        expect(screen.getByText('Three items are below reorder.')).toBeInTheDocument();
        expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBe(FIRST_NEW_CHAT);
      },
    );

    it('deleting a chat started on this page while it is open opens a new chat, as before (H9)', async () => {
      const server = fakeServer();
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.click(screen.getByRole('button', { name: SUGGESTION }));
      const answer = await answerTo(server, 1);
      await act(async () => {
        answer.text('Three items are below reorder.');
        answer.done();
      });
      await answerEnded();
      await waitFor(() => expect(railRow(SUGGESTION)).toHaveAttribute('aria-current', 'true'));
      deleteChat(SUGGESTION);
      await waitFor(() => expect(emptyChat()).toBeInTheDocument());
      expect(window.localStorage.getItem(ACTIVE_CHAT_ITEM)).toBeNull();
      expect(server.count(`DELETE /api/ai/sessions/${FIRST_NEW_CHAT}`)).toBe(1);
    });
  });

  describe('a file being read', () => {
    it('New chat while a file is read sends nothing, and says so (U1)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: ['extract'] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      pressNewChat();
      await act(async () => server.release('extract'));
      await fileReadEnded();
      await settle();
      expect(server.chatBodies).toHaveLength(0);
      expect(toast.warning).toHaveBeenCalledWith(NOT_SENT);
      expect(emptyChat()).toBeInTheDocument();
    });

    it('another chat opened, and loaded, while a file is read gets nothing, and the person is told (U3)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: ['extract'] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      openChat('Chat B');
      await screen.findByText('Two receipts came in this week.');
      await act(async () => server.release('extract'));
      await fileReadEnded();
      await settle();
      expect(server.chatBodies).toHaveLength(0);
      expect(toast.warning).toHaveBeenCalledWith(NOT_SENT);
      expect(userTurns()).toEqual(['Show recent receipts.']);
    });

    it('deleting the open chat while a file is read sends nothing, and says so (U4)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: ['extract'] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      deleteChat('Chat A');
      await waitFor(() => expect(emptyChat()).toBeInTheDocument());
      await act(async () => server.release('extract'));
      await fileReadEnded();
      await settle();
      expect(server.chatBodies).toHaveLength(0);
      expect(toast.warning).toHaveBeenCalledWith(NOT_SENT);
    });

    it('a chat clicked while a file is read, still loading when the read ends, gets nothing, then opens (U5)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: ['extract', CHAT_B] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      openChat('Chat B');
      await act(async () => server.release('extract'));
      await fileReadEnded();
      await settle();
      expect(server.chatBodies).toHaveLength(0);
      expect(toast.warning).toHaveBeenCalledWith(NOT_SENT);
      await act(async () => server.release(CHAT_B));
      await screen.findByText('Two receipts came in this week.');
      expect(userTurns()).toEqual(['Show recent receipts.']);
    });

    it('a click on the open chat while a file is read changes no chat: the file is sent there, with no warning (U6)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_A);
      const server = fakeServer({ chats: [CHAT_A, CHAT_B], hold: ['extract'] });
      render(<ChatPanel />);
      await screen.findByText('Two shelves are low.');
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      openChat('Chat A');
      await settle();
      await act(async () => server.release('extract'));
      await fileReadEnded();
      await settle();
      expect(toast.warning).not.toHaveBeenCalled();
      expect(server.chatBodies).toHaveLength(1);
      expect(server.chatBodies[0]!.sessionId).toBe(CHAT_A);
      expect(server.chatBodies[0]!.message).toContain('[Uploaded isbn-list.csv');
      expect(userTurns()).toHaveLength(2);
    });

    it('New chat pressed in an empty new chat while a file is read counts as changing chats: nothing is sent, and it says so (U7)', async () => {
      const server = fakeServer({ hold: ['extract'] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      pressNewChat();
      await act(async () => server.release('extract'));
      await fileReadEnded();
      await settle();
      expect(server.chatBodies).toHaveLength(0);
      expect(toast.warning).toHaveBeenCalledWith(NOT_SENT);
      expect(emptyChat()).toBeInTheDocument();
    });

    it('while a file is read, Send and the suggestions wait (U2, U2c)', async () => {
      const server = fakeServer({ hold: ['extract'] });
      render(<ChatPanel />);
      await within(rail()).findByText('Chat B');
      fireEvent.change(messageBox(), { target: { value: 'For the new term.' } });
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      expect(screen.getByRole('button', { name: SUGGESTION })).toBeDisabled();
      await act(async () => server.release('extract'));
      // Once the read ends, the file's ISBNs are sent, and only they.
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      expect(server.chatBodies[0]!.message).toContain('[Uploaded isbn-list.csv');
    });

    it('while a file is read, Confirm and Cancel wait (U2b)', async () => {
      window.localStorage.setItem(ACTIVE_CHAT_ITEM, CHAT_C);
      const server = fakeServer({ chats: [CHAT_C], hold: ['extract'] });
      render(<ChatPanel />);
      await screen.findByRole('button', { name: 'Confirm' });
      attachFile();
      await screen.findByPlaceholderText('Reading file…');
      expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      await act(async () => server.release('extract'));
      await waitFor(() => expect(server.chatBodies).toHaveLength(1));
      expect(server.chatBodies[0]!.sessionId).toBe(CHAT_C);
    });
  });
});
