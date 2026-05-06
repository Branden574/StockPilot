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

export interface ChatResult {
  reply: string;
  toolCallsUsed: Array<{ name: string; args: unknown; ok: boolean }>;
}

/**
 * Runs one chat turn. Accepts the full conversation history (so the
 * model has memory across turns) plus the new user message, and
 * returns the final assistant reply.
 *
 * Internally loops: model emits text OR a functionCall. If a function
 * call, we execute it against the user's ServiceContext (RLS enforced),
 * feed the result back, ask again. Cap at MAX_TOOL_HOPS to bound cost
 * and latency.
 */
export async function runChat(
  history: ChatTurn[],
  userMessage: string,
  ctx: ServiceContext,
): Promise<ChatResult> {
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

  // Convert prior turns to Gemini Content shape.
  const contents: Content[] = history.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const toolCallsUsed: ChatResult['toolCallsUsed'] = [];

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const result = await model.generateContent({ contents });
    const cand = result.response.candidates?.[0];
    const parts = cand?.content?.parts ?? [];

    // Find any function calls in this response.
    const toolCalls = parts.flatMap((p) =>
      'functionCall' in p && p.functionCall ? [p.functionCall] : [],
    );

    if (toolCalls.length === 0) {
      // Model produced final text. Concat all text parts and return.
      const text = parts
        .flatMap((p) => ('text' in p && typeof p.text === 'string' ? [p.text] : []))
        .join('')
        .trim();
      return { reply: text, toolCallsUsed };
    }

    // Append the model's call(s) to the conversation so the next round
    // sees the request, then execute each and append responses.
    contents.push({ role: 'model', parts: parts as Part[] });

    const responseParts: Part[] = [];
    for (const call of toolCalls) {
      const tool = TOOL_CATALOG[call.name];
      if (!tool) {
        toolCallsUsed.push({ name: call.name, args: call.args, ok: false });
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
        responseParts.push({
          functionResponse: {
            name: call.name,
            // Gemini expects the response wrapped as an object.
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

  // Hit the hop cap without finalizing — return what we have.
  return {
    reply:
      "I tried a few different lookups but couldn't pin down a clean answer. Try asking again with more specifics (e.g. an item name, SKU, or warehouse).",
    toolCallsUsed,
  };
}
