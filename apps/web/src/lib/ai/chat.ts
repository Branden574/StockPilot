import 'server-only';

import {
  GoogleGenerativeAI,
  type Content,
  type Part,
} from '@google/generative-ai';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import type { ServiceContext } from '@/server/services/context';

import { TOOL_CATALOG, toolDeclarations } from './tools';

// Same env-driven default as the scan extractor — see lib/env.ts.
export const CHAT_MODEL_NAME = env.GEMINI_MODEL;
const MAX_TOOL_HOPS = 6;

const SYSTEM_PROMPT = `You are StockPilot's inventory assistant — concise, factual, and grounded.

Rules:
- ALWAYS prefer calling a tool to look up real data over guessing.
- NEVER fabricate quantities, SKUs, item names, dates, or vendor info.
  If a tool didn't return it, say you don't have it.
- When the user asks about a warehouse by name, call listWarehouses
  first to resolve the UUID, then re-query with that UUID.
- For numeric facts, cite the number directly. For lists, prefer
  bullet points or a compact table.
- If a tool returns 0 results, say so — don't pretend you found
  something. Suggest filters that might help.
- If a tool returns an "error" field, say plainly that the lookup
  failed and what error came back. Do NOT pretend the question is
  out of scope when the question is in scope but the tool errored.
- Keep answers short. 1-3 sentences for simple lookups; bullet lists
  for multi-item results. No filler.
- Never claim you wrote anything to the database. The current tool
  set is read-only.
- The "out of scope" reply is ONLY for genuinely unrelated questions
  (general knowledge, weather, news, code questions). Inventory,
  stock, suppliers, warehouses, movements, POs, items, value, and
  reorder questions are ALL in scope — answer them via the tools.
  When unrelated, say "I'm scoped to your inventory data — try
  asking about items, stock levels, suppliers, or recent activity."`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
}

/**
 * Streaming events the chat loop yields. Server-side consumer (the
 * /api/ai/chat route) forwards these as NDJSON to the client. Each
 * event is a discrete unit so the UI can render incrementally:
 *
 *   - text  : a chunk of assistant text. Append to the live message.
 *   - tool  : a tool call resolved (success or fail). Show a badge.
 *
 * The route emits its own `done` and `error` events at the boundary —
 * the chat loop itself just yields text/tool and returns when the
 * model produces a final answer.
 */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; ok: boolean };

/**
 * Streams one chat turn. Yields text deltas as Gemini emits them and
 * tool events as tools resolve. Same tool-call loop semantics as
 * before — bounded by MAX_TOOL_HOPS — but every text chunk is
 * surfaced as it arrives instead of buffered until the end.
 *
 * The async-iterator shape lets the route compose this with a
 * ReadableStream cleanly: just `for await (const ev of streamChat(...))`
 * and forward each event.
 */
export async function* streamChat(
  history: ChatTurn[],
  userMessage: string,
  ctx: ServiceContext,
): AsyncGenerator<ChatStreamEvent, { reply: string; toolCallsUsed: ToolCallRecord[] }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey and add it to apps/web/.env.local + Vercel project env.',
    );
  }
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: CHAT_MODEL_NAME,
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: toolDeclarations() }],
  });

  const contents: Content[] = history.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const toolCallsUsed: ToolCallRecord[] = [];
  let assembledReply = '';

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const result = await model.generateContentStream({ contents });

    // Buffers for this round only.
    const roundParts: Part[] = [];
    let roundText = '';
    const roundToolCalls: Array<{ name: string; args: unknown }> = [];

    for await (const chunk of result.stream) {
      const cand = chunk.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      for (const p of parts) {
        roundParts.push(p as Part);
        if ('text' in p && typeof p.text === 'string' && p.text.length > 0) {
          roundText += p.text;
          yield { type: 'text', delta: p.text };
        } else if ('functionCall' in p && p.functionCall) {
          roundToolCalls.push({ name: p.functionCall.name, args: p.functionCall.args });
        }
      }
    }

    assembledReply += roundText;

    if (roundToolCalls.length === 0) {
      // Final text answer — done.
      return { reply: assembledReply, toolCallsUsed };
    }

    // Append the model's parts so the next round sees the call(s).
    contents.push({ role: 'model', parts: roundParts });

    const responseParts: Part[] = [];
    for (const call of roundToolCalls) {
      const tool = TOOL_CATALOG[call.name];
      if (!tool) {
        toolCallsUsed.push({ name: call.name, args: call.args, ok: false });
        yield { type: 'tool', name: call.name, ok: false };
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { error: `Unknown tool: ${call.name}` },
          },
        });
        continue;
      }
      try {
        const out = await tool.execute(
          (call.args as Record<string, unknown>) ?? {},
          ctx,
        );
        toolCallsUsed.push({ name: call.name, args: call.args, ok: true });
        yield { type: 'tool', name: call.name, ok: true };
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: out },
          },
        });
      } catch (err) {
        toolCallsUsed.push({ name: call.name, args: call.args, ok: false });
        const message = err instanceof Error ? err.message : String(err);
        void reportError(err, {
          tag: 'ai.tool',
          extra: { tool: call.name },
          organizationId: ctx.organizationId,
        });
        yield { type: 'tool', name: call.name, ok: false };
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { error: message },
          },
        });
      }
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // Hit the hop cap. Return what we have so the route can persist it.
  if (!assembledReply) {
    assembledReply =
      "I tried a few different lookups but couldn't pin down a clean answer. Try asking again with more specifics (e.g. an item name, SKU, or warehouse).";
    yield { type: 'text', delta: assembledReply };
  }
  return { reply: assembledReply, toolCallsUsed };
}
