import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { parseTsx, readSource } from './__fixtures__/jsx-touch-audit';
import { screenFunction } from './__fixtures__/screen-functions';
import { buildChatRequestBody, ChatFailure, chatRefusalSentence, parseChatStream } from './ai-chat';
import { CONNECTION_FAILURE_COPY } from './connection-copy';

/**
 * THE PHONE AI CHAT SCREEN, RUN (docket B75 review). send(), startNewChat()
 * and attachPhoto() are app/ai/chat.tsx's own code (screen-functions.ts).
 * React's state and refs are modelled here, and the server, the photo picker
 * and the upload are stubs that each test answers when it chooses.
 *
 * Two messages can be on their way at once. Send stays enabled while a
 * book-list photo uploads, and the photo's message goes out when the upload
 * ends, from the send() of the render the upload started in. Each send
 * cleared the screen's one busy flag when its own answer landed, so New chat
 * (+) showed while the other answer was still on its way. And an answer
 * applied itself to whatever chat was on screen when it landed: after New
 * chat, the photo's late answer put the old chat's session id back, so the
 * next message went on in the old chat (on the web too), and a late failure
 * showed Chat error in the new chat.
 */

const CHAT = 'app/ai/chat.tsx';
const SOURCE = parseTsx(readSource(path.resolve(__dirname, '../..', CHAT)), CHAT);

const OLD = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const NEW = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  tools?: { name: string; ok: boolean }[];
  streaming?: boolean;
}

interface ScreenState {
  turns: Turn[];
  input: string;
  busy: boolean;
  uploading: boolean;
}

/** What fetch resolves with: as much of a Response as send() reads. */
interface Answer {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}

interface SentRequest {
  body: Record<string, unknown>;
  answer: (res: Answer) => void;
  drop: (err: Error) => void;
}

/** A ref's start value: the screen starts each one as a literal. */
function literal(node: ts.Expression | undefined): unknown {
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  throw new Error(`a ref in ${CHAT} starts as ${node.getText(SOURCE)}: model it here`);
}

/** Every `React.useRef(...)` of the screen, as it starts: one set per mount. */
function screenRefs(): Record<string, { current: unknown }> {
  const refs: Record<string, { current: unknown }> = {};
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(SOURCE) === 'React.useRef'
    ) {
      refs[n.name.text] = { current: literal(n.initializer.arguments[0]) };
    }
    ts.forEachChild(n, visit);
  };
  visit(SOURCE);
  return refs;
}

/**
 * Whether the screen shows New chat (+): its condition,
 * `turns.length > 0 && !busy && !uploading`, whose text
 * workspace-screens-structure.test.ts pins.
 */
const newChatShown = (s: ScreenState) => s.turns.length > 0 && !s.busy && !s.uploading;

/** The route's answer: one JSON event per line. */
const ndjson = (...events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

/** An answer naming its session first and in `done`, as the route streams it. */
const answered = (text: string, sessionId: string): Answer => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () =>
    ndjson(
      { type: 'session', id: sessionId },
      { type: 'text', delta: text },
      { type: 'done', sessionId, reply: text, toolCallsUsed: [] },
    ),
});

/** A refusal, as the route answers one (a JSON body, no stream). */
const refused = (status: number, body: Record<string, string>): Answer => ({
  ok: false,
  status,
  statusText: '',
  text: async () => JSON.stringify(body),
});

const RATE_LIMITED = 'Too many AI chat requests. Slow down for a moment.';

/** Lets every await the screen is in finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One mounted chat screen: its state, its refs and what it sent. */
function chatScreen() {
  const state: ScreenState = { turns: [], input: '', busy: false, uploading: false };
  const refs = screenRefs();
  const requests: SentRequest[] = [];
  const uploads: ((isbns: string[]) => void)[] = [];
  const alerts: string[][] = [];
  const notifyUnauthorized = vi.fn();

  function setter<K extends keyof ScreenState>(key: K) {
    return (next: ScreenState[K] | ((prev: ScreenState[K]) => ScreenState[K])) => {
      state[key] =
        typeof next === 'function'
          ? (next as (prev: ScreenState[K]) => ScreenState[K])(state[key])
          : next;
    };
  }

  const stubs = {
    API_BASE: 'https://app.example.test',
    orgHeader: async () => ({}),
    supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
    fetch: (_url: string, init: { body: string }) =>
      new Promise<Answer>((answer, drop) => {
        requests.push({ body: JSON.parse(init.body) as Record<string, unknown>, answer, drop });
      }),
    notifyUnauthorized,
    buildChatRequestBody,
    ChatFailure,
    chatRefusalSentence,
    parseChatStream,
    CONNECTION_FAILURE_COPY,
    scrollToBottom: () => undefined,
    Alert: {
      alert: (
        title: string,
        message?: string,
        buttons?: { text: string; onPress?: () => void }[],
      ) => {
        // The photo flow asks where the photo comes from: the library.
        const library = buttons?.find((b) => b.text === 'Choose from library');
        if (library) library.onPress?.();
        else alerts.push([title, message ?? '']);
      },
    },
    ImagePicker: {
      MediaTypeOptions: { Images: 'Images' },
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({
        canceled: false,
        assets: [{ uri: 'file:///booklist.jpg' }],
      }),
    },
    resizeForUpload: async () => ({ uri: 'file:///booklist-small.jpg', ext: 'jpg' }),
    postMultipart: () =>
      new Promise((resolve) => {
        uploads.push((isbns) =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ isbns, totalFound: isbns.length }),
          }),
        );
      }),
  };

  /** The handlers one render of the screen made: its values, the mount's refs and setters. */
  function render() {
    const deps: Record<string, unknown> = {
      ...stubs,
      ...refs,
      turns: state.turns,
      input: state.input,
      busy: state.busy,
      uploading: state.uploading,
      setTurns: setter('turns'),
      setInput: setter('input'),
      setBusy: setter('busy'),
      setUploading: setter('uploading'),
    };
    const send = screenFunction<(text?: string) => Promise<void>>(CHAT, 'send', deps);
    return {
      send,
      startNewChat: screenFunction<() => void>(CHAT, 'startNewChat', deps),
      attachPhoto: screenFunction<() => Promise<void>>(CHAT, 'attachPhoto', { ...deps, send }),
      newChatShown: newChatShown(state),
    };
  }

  /** The person types `text` and presses Send (send() refuses while busy, as Send is disabled). */
  async function sendTyped(text: string) {
    state.input = text;
    void render().send();
    await settle();
  }

  return { state, refs, requests, uploads, alerts, notifyUnauthorized, render, sendTyped };
}

/**
 * A chat that holds a session (OLD), then the race: a photo upload starts, a
 * typed message is sent while it uploads, the upload ends and the photo's
 * message goes out, and the typed message's answer lands first. The photo's
 * request (requests[2]) is still on its way.
 */
async function photoRace() {
  const screen = chatScreen();
  await screen.sendTyped("What's low at our biggest warehouse?");
  screen.requests[0]!.answer(answered('Three items are low.', OLD));
  await settle();
  expect(screen.refs.sessionRef!.current).toBe(OLD);
  expect(screen.render().newChatShown).toBe(true);

  // The upload starts from this render, and Send is pressed while it runs.
  const upload = screen.render().attachPhoto();
  await settle();
  expect(screen.state.uploading).toBe(true);
  await screen.sendTyped('Show me POs that are overdue.');

  // The upload ends: the photo's message goes out too, in the same chat.
  screen.uploads[0]!(['9780000000002', '9780000000019']);
  await upload;
  await settle();
  expect(screen.state.uploading).toBe(false);
  expect(screen.requests.map((r) => r.body.sessionId)).toEqual([undefined, OLD, OLD]);
  expect(screen.requests[2]!.body.message).toMatch(
    /^I uploaded a photo of a book list\. Please add these 2 books by ISBN:\n/,
  );

  // The typed message's answer lands first.
  screen.requests[1]!.answer(answered('Two purchase orders are overdue.', OLD));
  await settle();
  return screen;
}

describe('the AI chat screen while two messages are on their way', () => {
  it('stays busy, with New chat hidden, until the last answer is in', async () => {
    const screen = await photoRace();
    expect(screen.state.busy).toBe(true);
    expect(screen.render().newChatShown).toBe(false);

    screen.requests[2]!.answer(answered('Added 2 books.', OLD));
    await settle();
    expect(screen.state.busy).toBe(false);
    expect(screen.render().newChatShown).toBe(true);
    expect(screen.refs.sessionRef!.current).toBe(OLD);
    expect(screen.alerts).toEqual([]);
  });

  // New chat is only offered while nothing is on its way, but a tap the
  // screen takes before it has drawn the chip away still runs startNewChat.
  it("an answer that lands after New chat stays the old chat's: the next message starts a chat of its own", async () => {
    const screen = await photoRace();
    screen.render().startNewChat();
    expect(screen.state.turns).toEqual([]);

    screen.requests[2]!.answer(answered('Added 2 books.', OLD));
    await settle();
    expect(screen.refs.sessionRef!.current).toBeNull();
    expect(screen.state.turns).toEqual([]);
    expect(screen.state.busy).toBe(false);
    expect(screen.alerts).toEqual([]);

    await screen.sendTyped('How many Chromebooks did we receive this month?');
    expect(screen.requests[3]!.body).toEqual({
      message: 'How many Chromebooks did we receive this month?',
    });
    screen.requests[3]!.answer(answered('Twelve Chromebooks.', NEW));
    await settle();
    expect(screen.state.turns).toEqual([
      { role: 'user', content: 'How many Chromebooks did we receive this month?' },
      { role: 'assistant', content: 'Twelve Chromebooks.', tools: [], streaming: false },
    ]);
    expect(screen.refs.sessionRef!.current).toBe(NEW);
  });

  // So the old chat's answer never meets a message of the new chat: it can
  // neither fill that message's bubble nor end its wait.
  it("after New chat, Send waits until the old chat's last answer is in", async () => {
    const screen = await photoRace();
    screen.render().startNewChat();
    await screen.sendTyped('How many Chromebooks did we receive this month?');
    expect(screen.requests).toHaveLength(3);
    expect(screen.state.busy).toBe(true);
    expect(screen.render().newChatShown).toBe(false);

    screen.requests[2]!.answer(answered('Added 2 books.', OLD));
    await settle();
    expect(screen.state.busy).toBe(false);
    await screen.sendTyped('How many Chromebooks did we receive this month?');
    expect(screen.requests[3]!.body).toEqual({
      message: 'How many Chromebooks did we receive this month?',
    });
  });

  it('a refusal or a lost answer after New chat is not said in the new chat', async () => {
    for (const fail of [
      (r: SentRequest) => r.answer(refused(429, { error: 'rate_limited', message: RATE_LIMITED })),
      (r: SentRequest) => r.drop(new TypeError('Network request failed')),
    ]) {
      const screen = await photoRace();
      screen.render().startNewChat();
      fail(screen.requests[2]!);
      await settle();
      expect(screen.alerts).toEqual([]);
      expect(screen.state.turns).toEqual([]);
      expect(screen.state.busy).toBe(false);
      expect(screen.refs.sessionRef!.current).toBeNull();
    }
  });

  // The account probe is about the account, not the chat.
  it('a 401 that lands after New chat still asks for the account probe', async () => {
    const screen = await photoRace();
    screen.render().startNewChat();
    screen.requests[2]!.answer(refused(401, { error: 'unauthorized' }));
    await settle();
    expect(screen.notifyUnauthorized).toHaveBeenCalledWith({ status: 401 });
    expect(screen.alerts).toEqual([]);
  });

  it('without New chat, a late refusal is said in the chat it was sent in', async () => {
    const screen = await photoRace();
    screen.requests[2]!.answer(refused(429, { error: 'rate_limited', message: RATE_LIMITED }));
    await settle();
    expect(screen.alerts).toEqual([['Chat error', RATE_LIMITED]]);
    expect(screen.state.busy).toBe(false);
    expect(screen.refs.sessionRef!.current).toBe(OLD);
  });
});
