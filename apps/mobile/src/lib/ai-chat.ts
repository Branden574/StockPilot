/**
 * The phone AI chat's request body and the reader for its answer, as the
 * screen (app/ai/chat.tsx) built them inline. Moved here unchanged, with no
 * React Native or Expo import, so they run under vitest (src/ only, in node:
 * a screen cannot load there).
 */

export interface ChatTurnLike {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatTool {
  name: string;
  ok: boolean;
}

/** The request: every non-empty turn on screen, and the session id as held. */
export function buildChatRequestBody(
  message: string,
  sessionId: string | undefined,
  turns: readonly ChatTurnLike[],
) {
  // Build the history payload the server expects (excludes the new
  // user message since it's passed separately).
  const history = turns
    .filter((t) => t.content.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.content }));
  return { message, sessionId, history };
}

export interface ChatAnswer {
  text: string;
  tools: ChatTool[];
  errorMessage: string | null;
  sessionId: string | null;
}

/** The route's NDJSON answer, read in one pass. */
export function parseChatStream(fullText: string): ChatAnswer {
  const lines = fullText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let assistantText = '';
  const tools: ChatTool[] = [];
  let errorMessage: string | null = null;
  let sessionId: string | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as
        | { type: 'text'; delta: string }
        | { type: 'tool'; name: string; ok: boolean }
        | { type: 'session'; id: string }
        | { type: 'done' }
        | { type: 'error'; message?: string };
      if (event.type === 'text') {
        assistantText += event.delta;
      } else if (event.type === 'tool') {
        tools.push({ name: event.name, ok: event.ok });
      } else if (event.type === 'session') {
        sessionId = event.id;
      } else if (event.type === 'error') {
        errorMessage = event.message ?? 'AI error';
      }
    } catch (parseErr) {
      console.warn('[ai] bad line', line.slice(0, 100), parseErr);
    }
  }

  return { text: assistantText, tools, errorMessage, sessionId };
}

/** What a refused request shows: its status and the start of its body. */
export function chatRefusalSentence(status: number, raw: string, statusText = ''): string {
  return `AI chat ${status}: ${raw.slice(0, 200) || statusText}`;
}
