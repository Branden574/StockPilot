import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AI_CHAT_LIMITS,
  buildChatRequestBody,
  ChatFailure,
  chatRefusalSentence,
  isSessionId,
  parseChatStream,
} from './ai-chat';

/**
 * The phone AI chat's request and answer (docket B75).
 *
 * In one phone chat, about the 22nd message and every one after it was
 * refused until the person left the chat. The screen sent its whole on-screen
 * transcript as `history` with every message, and the route refuses more than
 * 40 turns, or a turn over 8,000 characters (a long reply, or a long pasted
 * message the route had refused and the screen kept). The screen never held a
 * session either: it listened for a `session` event that nothing sent and
 * ignored the id the route sends in `done`, so every message became a chat of
 * its own in the person's list on the web. And a refusal showed
 * "AI chat 400: " and the raw response text.
 *
 * These run the screen's own functions (app/ai/chat.tsx cannot load under
 * vitest, so its logic lives in ai-chat.ts): the id is read from `done` (and
 * from the route's early `session` event), a chat that holds one sends no
 * history, as the web does, a chat that holds none sends at most what the
 * route accepts, and a refusal reads as a sentence.
 */

const ROUTE = readFileSync(
  path.resolve(__dirname, '../../../web/src/app/api/ai/chat/route.ts'),
  'utf8',
);

/** A cap from the route's own schema, so these check what the route accepts. */
function routeCap(re: RegExp): number {
  const m = re.exec(ROUTE);
  if (!m) throw new Error(`route.ts no longer matches ${re}`);
  return Number(m[1]);
}

const ROUTE_LIMITS = {
  messageChars: routeCap(/message: z\.string\(\)\.min\(1\)\.max\((\d+)\)/),
  historyTurns: routeCap(/history: z\.array\(turnSchema\)\.max\((\d+)\)/),
  turnChars: routeCap(/content: z\.string\(\)\.min\(1\)\.max\((\d+)\)/),
};

const SESSION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

/** The route's answer: one JSON event per line. */
const ndjson = (...events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

type Turn = { role: 'user' | 'assistant'; content: string };

describe('parseChatStream: what the route answered', () => {
  // A garbled line is logged (as the screen always did), never thrown.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the text, the tools and the session id from done', () => {
    const answer = parseChatStream(
      ndjson(
        { type: 'text', delta: 'Three items ' },
        { type: 'tool', name: 'searchInventory', ok: true },
        { type: 'tool', name: 'getItemDetails', ok: false },
        { type: 'text', delta: 'are low.' },
        {
          type: 'done',
          sessionId: SESSION,
          reply: 'Three items are low.',
          toolCallsUsed: [{ name: 'searchInventory', ok: true }],
        },
      ),
    );
    expect(answer).toEqual({
      text: 'Three items are low.',
      tools: [
        { name: 'searchInventory', ok: true },
        { name: 'getItemDetails', ok: false },
      ],
      errorMessage: null,
      sessionId: SESSION,
    });
  });

  it('an error event, then done: the error sentence, and the session id still kept', () => {
    // The route sends done after any error event (route.ts, the stream's finally).
    const answer = parseChatStream(
      ndjson(
        { type: 'text', delta: 'Partial' },
        {
          type: 'error',
          code: 'rate_limited',
          message: 'The AI service is busy. Try again shortly.',
        },
        { type: 'done', sessionId: SESSION, reply: 'Partial', toolCallsUsed: [] },
      ),
    );
    expect(answer.errorMessage).toBe('The AI service is busy. Try again shortly.');
    expect(answer.sessionId).toBe(SESSION);
  });

  it("an error event without a message reads as the web chat's sentence", () => {
    const answer = parseChatStream(ndjson({ type: 'error' }, { type: 'done', sessionId: SESSION }));
    expect(answer.errorMessage).toBe('The AI assistant ran into a problem. Try again in a moment.');
  });

  it("the early session event names the chat, and done's id wins when they differ", () => {
    expect(
      parseChatStream(
        ndjson(
          { type: 'session', id: SESSION },
          { type: 'text', delta: 'Hello.' },
          { type: 'done', sessionId: SESSION },
        ),
      ).sessionId,
    ).toBe(SESSION);
    expect(
      parseChatStream(
        ndjson(
          { type: 'session', id: OTHER },
          { type: 'text', delta: 'Hello.' },
          { type: 'done', sessionId: SESSION },
        ),
      ).sessionId,
    ).toBe(SESSION);
    // An answer that ends before done still names its chat.
    expect(
      parseChatStream(ndjson({ type: 'session', id: SESSION }, { type: 'text', delta: 'Hel' }))
        .sessionId,
    ).toBe(SESSION);
  });

  it('ignores an id the route would refuse, unknown events and garbled lines, and keeps the text', () => {
    const answer = parseChatStream(
      [
        JSON.stringify({ type: 'session', id: 'sess-1' }),
        JSON.stringify({ type: 'text', delta: 'Hello' }),
        '{"type":"text","delta":"cut sho',
        JSON.stringify({ type: 'heartbeat' }),
        'not json',
        JSON.stringify(null),
        JSON.stringify({ type: 'text', delta: ' there.' }),
        JSON.stringify({ type: 'done', sessionId: '' }),
      ].join('\n'),
    );
    expect(answer).toEqual({
      text: 'Hello there.',
      tools: [],
      errorMessage: null,
      sessionId: null,
    });
    expect(parseChatStream(ndjson({ type: 'done', sessionId: 123 })).sessionId).toBeNull();
    expect(parseChatStream(ndjson({ type: 'session', id: '' })).sessionId).toBeNull();
    expect(parseChatStream('').sessionId).toBeNull();
  });
});

describe('isSessionId: only an id the route accepts', () => {
  it('accepts the form gen_random_uuid() produces, in either case', () => {
    expect(isSessionId(SESSION)).toBe(true);
    expect(isSessionId(SESSION.toUpperCase())).toBe(true);
  });

  it('refuses anything else, so a chat never keeps an id that would refuse every message', () => {
    for (const v of [
      'sess-1',
      '',
      123,
      null,
      undefined,
      '00000000-0000-0000-0000-000000000000',
      '6f1c2a3b-4d5e-0f60-8a7b-9c0d1e2f3a4b',
      '6f1c2a3b-4d5e-4f60-ca7b-9c0d1e2f3a4b',
      `${SESSION} `,
      `x${SESSION}`,
    ]) {
      expect(isSessionId(v), String(v)).toBe(false);
    }
  });
});

describe('buildChatRequestBody: what the phone sends', () => {
  it('a chat that holds a session sends exactly { message, sessionId }, no history', () => {
    const turns: Turn[] = [
      { role: 'user', content: 'How many chairs?' },
      { role: 'assistant', content: 'Twelve.' },
    ];
    const body = buildChatRequestBody('And tables?', SESSION, turns);
    expect(body).toEqual({ message: 'And tables?', sessionId: SESSION });
    expect(Object.keys(body)).toEqual(['message', 'sessionId']);
  });

  it('a chat without one sends the last 40 non-empty turns, role and content only', () => {
    const turns: (Turn & { tools?: unknown[]; streaming?: boolean })[] = Array.from(
      { length: 50 },
      (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i}`,
        tools: [],
        streaming: false,
      }),
    );
    // An answer still empty, as the screen's bubble is while it waits.
    turns.splice(45, 0, { role: 'assistant', content: '   ', streaming: true });
    const body = buildChatRequestBody('next', null, turns);
    expect(Object.keys(body)).toEqual(['message', 'history']);
    expect(body.history).toHaveLength(ROUTE_LIMITS.historyTurns);
    expect(body.history?.[0]).toEqual({ role: 'user', content: 'turn 10' });
    expect(body.history?.at(-1)).toEqual({ role: 'assistant', content: 'turn 49' });
    expect(body.history?.some((t) => t.content.trim() === '')).toBe(false);
  });

  it('a chat without one, and with no turns yet, sends no history key', () => {
    expect(buildChatRequestBody('first', null, [])).toEqual({ message: 'first' });
    expect(Object.keys(buildChatRequestBody('first', null, []))).toEqual(['message']);
    expect(
      Object.keys(buildChatRequestBody('first', null, [{ role: 'assistant', content: ' ' }])),
    ).toEqual(['message']);
  });

  it('an id the route would refuse is not sent: the chat sends its turns instead', () => {
    const turns: Turn[] = [{ role: 'user', content: 'q' }];
    expect(buildChatRequestBody('next', 'sess-1', turns)).toEqual({
      message: 'next',
      history: [{ role: 'user', content: 'q' }],
    });
  });

  it('cuts a turn over 8,000 units at 8,000, one earlier where the cut would split a character', () => {
    // U+1D400 is two UTF-16 units; placed so that its first unit is the 8,000th.
    const astral = String.fromCodePoint(0x1d400);
    const turns: Turn[] = [
      { role: 'user', content: 'p'.repeat(9000) },
      { role: 'assistant', content: `${'a'.repeat(7999)}${astral}${'b'.repeat(50)}` },
      { role: 'user', content: 'q'.repeat(ROUTE_LIMITS.turnChars) },
    ];
    const history = buildChatRequestBody('next', null, turns).history ?? [];
    expect(history.map((t) => t.content.length)).toEqual([8000, 7999, 8000]);
    expect(history[0]!.content).toBe('p'.repeat(8000));
    expect(history[1]!.content).toBe('a'.repeat(7999));
    // No turn ends in half a character.
    for (const t of history) {
      const last = t.content.charCodeAt(t.content.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('a 30-message chat never sends a history the route refuses, and from message 2 on sends none', () => {
    // The screen's own loop: show the question, send, keep the id the answer
    // names, show the answer. Message 5 gets a 9,000-character reply; message
    // 7 is a 9,000-character paste the route refuses (over 2,000), which the
    // screen keeps on screen, as it always has.
    let held: string | null = null;
    let turns: Turn[] = [];
    const bodies: ReturnType<typeof buildChatRequestBody>[] = [];
    for (let k = 1; k <= 30; k++) {
      const message = k === 7 ? 'p'.repeat(9000) : `Question ${k}?`;
      bodies.push(buildChatRequestBody(message, held, turns));
      turns = [...turns, { role: 'user', content: message }];
      if (message.length > ROUTE_LIMITS.messageChars) continue;
      const reply = k === 5 ? 'r'.repeat(9000) : `Answer ${k}.`;
      const answer = parseChatStream(
        ndjson(
          { type: 'session', id: SESSION },
          { type: 'text', delta: reply },
          { type: 'done', sessionId: SESSION, reply, toolCallsUsed: [] },
        ),
      );
      if (answer.sessionId) held = answer.sessionId;
      turns = [...turns, { role: 'assistant', content: answer.text || '(no response)' }];
    }

    // Every body the route would refuse for its history, named.
    const refused = bodies.flatMap((body, i) => {
      const history = body.history ?? [];
      const out: string[] = [];
      if (history.length > ROUTE_LIMITS.historyTurns) {
        out.push(`message ${i + 1}: ${history.length} turns`);
      }
      const bad = history.filter(
        (t) => t.content.length < 1 || t.content.length > ROUTE_LIMITS.turnChars,
      ).length;
      if (bad > 0)
        out.push(`message ${i + 1}: ${bad} turn(s) outside 1 to ${ROUTE_LIMITS.turnChars}`);
      return out;
    });
    expect(refused).toEqual([]);
    expect(bodies[0]).toEqual({ message: 'Question 1?' });
    expect(bodies.slice(1).filter((b) => 'history' in b)).toEqual([]);
    expect(bodies.slice(1).every((b) => b.sessionId === SESSION)).toBe(true);
  });
});

describe('chatRefusalSentence: a refused message reads as a sentence', () => {
  // The old alert: "AI chat 400: " and the start of the raw body.
  const NEVER = [
    /[{}]/,
    /AI chat \d/,
    /\b(?:400|401|403|429|502)\b/,
    /validation_error|unauthorized|forbidden/,
  ];

  it.each([
    [
      "S16's long-conversation refusal",
      400,
      JSON.stringify({
        error: 'validation_error',
        message: 'This conversation is too long. Start a new chat.',
      }),
      'This conversation is too long. Start a new chat.',
    ],
    [
      'a message over 2,000 characters',
      400,
      JSON.stringify({
        error: 'validation_error',
        message: 'Your message is too long. Keep it under 2,000 characters.',
      }),
      'Your message is too long. Keep it under 2,000 characters.',
    ],
    [
      'no session (401, code only)',
      401,
      JSON.stringify({ error: 'unauthorized' }),
      'You do not have access to that.',
    ],
    [
      'no permission (403, code only)',
      403,
      JSON.stringify({ error: 'forbidden' }),
      'You do not have access to that.',
    ],
    [
      'the module turned off',
      403,
      JSON.stringify({
        error: 'module_disabled',
        message: 'Module not enabled for this organization: ai',
      }),
      'Module not enabled for this organization: ai',
    ],
    [
      'the per-person limit',
      429,
      JSON.stringify({
        error: 'rate_limited',
        message: 'Too many AI chat requests. Slow down for a moment.',
        retryAt: 1,
      }),
      'Too many AI chat requests. Slow down for a moment.',
    ],
    [
      'a gateway page',
      502,
      '<!DOCTYPE html><html><body>Bad gateway</body></html>',
      'The server had a problem. Try again in a moment.',
    ],
    [
      'a code without a message',
      400,
      JSON.stringify({ error: 'validation_error' }),
      'Request failed (400).',
    ],
    ['an empty message', 400, '{"message":""}', 'Request failed (400).'],
  ])('%s', (_what, status, raw, sentence) => {
    const said = chatRefusalSentence(status, raw);
    expect(said).toBe(sentence);
    if (sentence !== 'Request failed (400).') {
      for (const never of NEVER) expect(said).not.toMatch(never);
    }
  });

  it('a failure that carries a sentence is marked as one', () => {
    const f = new ChatFailure('This conversation is too long. Start a new chat.');
    expect(f).toBeInstanceOf(Error);
    expect(f).toBeInstanceOf(ChatFailure);
    expect(f.message).toBe('This conversation is too long. Start a new chat.');
    expect(new Error('fetch failed') instanceof ChatFailure).toBe(false);
  });
});

describe("the phone's limits and events match the route's (drift guard)", () => {
  it('the history and turn caps, and the session id the schema accepts', () => {
    expect(AI_CHAT_LIMITS).toEqual({
      historyTurns: ROUTE_LIMITS.historyTurns,
      turnChars: ROUTE_LIMITS.turnChars,
    });
    expect(ROUTE).toContain(`content: z.string().min(1).max(${AI_CHAT_LIMITS.turnChars})`);
    expect(ROUTE).toContain(`history: z.array(turnSchema).max(${AI_CHAT_LIMITS.historyTurns})`);
    expect(ROUTE).toContain('sessionId: z.string().uuid().optional()');
  });

  it('the route names the session first, and again in done', () => {
    expect(ROUTE).toContain("send({ type: 'session', id: finalSessionId })");
    expect(ROUTE).toMatch(/type: 'done',\s*sessionId: finalSessionId,/);
  });

  it("an error without a message reads as the web chat's words", () => {
    const panel = readFileSync(
      path.resolve(__dirname, '../../../web/src/components/ai/chat-panel.tsx'),
      'utf8',
    );
    expect(panel).toContain("'The AI assistant ran into a problem. Try again in a moment.'");
  });
});
