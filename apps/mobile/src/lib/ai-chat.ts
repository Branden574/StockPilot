import { readErrorBody, statusSentence } from './api-error-body';

/**
 * The phone AI chat's request and the reader for its answer (app/ai/chat.tsx
 * calls /api/ai/chat with fetch itself, to read the route's NDJSON stream).
 * No React Native or Expo import, so they run under vitest (src/ only, in
 * node: a screen cannot load there): ai-chat.test.ts.
 *
 * DOCKET B75. The screen sent its whole on-screen transcript as `history`
 * with every message, and listened for a `session` event that nothing sent,
 * so it never held a session. The route refuses more than 40 turns of
 * history, or a turn over 8,000 characters, so about the 22nd message of a
 * chat was refused, and every message after a reply (or a pasted message)
 * over 8,000 characters, until the person left the chat; and each message
 * became a chat of its own in the person's list on the web. A refusal showed
 * "AI chat 400: " and the raw response.
 *
 * Now the chat keeps the session the route names (in `done`, and in its
 * early `session` event), and while it holds one it sends no history: the
 * route answers from the session's own stored turns, as for the web chat
 * (components/ai/chat-panel.tsx sends message, sessionId and pageContext).
 * Without one (the first message, or after a lost session) it sends at most
 * what the route accepts. A refusal reads as a sentence.
 */

/**
 * The route's caps on `history` (bodySchema, turnSchema in
 * apps/web/src/app/api/ai/chat/route.ts). ai-chat.test.ts reads the route and
 * fails when they differ.
 */
export const AI_CHAT_LIMITS = { historyTurns: 40, turnChars: 8000 } as const;

/**
 * The web chat's words for an error event without a message
 * (components/ai/chat-panel.tsx).
 */
const AI_CHAT_FAILED = 'The AI assistant ran into a problem. Try again in a moment.';

/**
 * A session id the route accepts, in the form gen_random_uuid() produces (an
 * RFC 9562 UUID: version 1 to 8, variant 8 to b). The route's schema checks
 * `z.string().uuid()`; zod 3 accepts any 8-4-4-4-12 hex and zod 4 only this
 * form (and the nil and max ids, which the database never makes). A chat
 * that kept anything else would send it with every message and be refused
 * every time, so anything else is not an id.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export interface ChatTurnLike {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatTool {
  name: string;
  ok: boolean;
}

export interface ChatRequestBody {
  message: string;
  sessionId?: string;
  history?: ChatTurnLike[];
}

/**
 * A turn the route accepts: at most AI_CHAT_LIMITS.turnChars UTF-16 units
 * (the length zod counts), its start kept. A cut that would leave the first
 * half of a surrogate pair at the end is made one unit earlier.
 */
function cutTurn(content: string): string {
  if (content.length <= AI_CHAT_LIMITS.turnChars) return content;
  let end = AI_CHAT_LIMITS.turnChars;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return content.slice(0, end);
}

/**
 * The request for one message.
 *
 * Holding a session: `{ message, sessionId }` and no history, exactly as the
 * web chat sends. The route reads the session's stored turns (the newest 60,
 * cut to 40) and never reads a history sent beside a session it holds.
 *
 * Holding none: `{ message, history }` with the last AI_CHAT_LIMITS.historyTurns
 * non-empty turns on screen, each cut to AI_CHAT_LIMITS.turnChars, so a long
 * reply or a long pasted message the route refused (the screen keeps the
 * question) cannot get the next message refused. No `history` key when there
 * is none. `turns` excludes the new message, which travels as `message`.
 */
export function buildChatRequestBody(
  message: string,
  sessionId: string | null | undefined,
  turns: readonly ChatTurnLike[],
): ChatRequestBody {
  if (isSessionId(sessionId)) return { message, sessionId };
  const history = turns
    .filter((t) => t.content.trim().length > 0)
    .slice(-AI_CHAT_LIMITS.historyTurns)
    .map((t) => ({ role: t.role, content: cutTurn(t.content) }));
  return history.length > 0 ? { message, history } : { message };
}

export interface ChatAnswer {
  text: string;
  tools: ChatTool[];
  /** The error event's sentence, when the route sent one. */
  errorMessage: string | null;
  /** The session the answer belongs to, when it named one the route accepts. */
  sessionId: string | null;
}

/**
 * The route's NDJSON answer, read in one pass (React Native's fetch gives no
 * readable stream, so the screen reads the whole body first).
 *
 * The route names the session twice: `{type:'session', id}` before anything
 * else (since B75), and `{type:'done', sessionId}` last, after any error
 * event. The id is read whether or not there was an error, so the next
 * message stays in this chat; `done` wins over the early event. A line that
 * is not JSON, an event this build does not know and an id the route would
 * refuse are skipped.
 */
export function parseChatStream(body: string): ChatAnswer {
  let text = '';
  const tools: ChatTool[] = [];
  let errorMessage: string | null = null;
  let earlyId: string | null = null;
  let doneId: string | null = null;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      event = parsed as Record<string, unknown>;
    } catch (parseErr) {
      console.warn('[ai] bad line', line.slice(0, 100), parseErr);
      continue;
    }
    if (event.type === 'text' && typeof event.delta === 'string') {
      text += event.delta;
    } else if (event.type === 'tool' && typeof event.name === 'string') {
      tools.push({ name: event.name, ok: event.ok === true });
    } else if (event.type === 'error') {
      errorMessage =
        typeof event.message === 'string' && event.message ? event.message : AI_CHAT_FAILED;
    } else if (event.type === 'session' && isSessionId(event.id)) {
      earlyId = event.id;
    } else if (event.type === 'done' && isSessionId(event.sessionId)) {
      doneId = event.sessionId;
    }
  }

  return { text, tools, errorMessage, sessionId: doneId ?? earlyId };
}

/**
 * What the chat says when the route refused the message (a non-2xx answer):
 * the route's own sentence, or the sentence for the status. Never the body,
 * and never the bare code: the 401 and 403 the route answers before reading
 * the body carry a code and no message (`{error:'unauthorized'}`,
 * `{error:'forbidden'}`).
 */
export function chatRefusalSentence(status: number, raw: string): string {
  return readErrorBody(raw).message || statusSentence(status);
}

/**
 * A chat failure that already carries a sentence a person can act on (a
 * refusal, or the route's error event). Anything else that fails a send (no
 * answer at all, a dropped connection) reads as the connection sentence.
 */
export class ChatFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatFailure';
  }
}
