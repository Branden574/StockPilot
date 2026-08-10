import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';

import { TOOL_CATALOG, toolDeclarations } from './tools';
import {
  classifyToolErrorMessage,
  executeToolCall,
  MAX_HISTORY_TURNS,
  MAX_TOOL_CALLS_PER_ROUND,
  MAX_TOOL_HOPS,
  newTurnOriginRegistry,
  runWithUntrustedOrigins,
  scrubDataTags,
  SYSTEM_PROMPT,
  type ChatStreamEvent,
  type ChatTurn,
  type ToolCallRecord,
} from './chat';
import type { ServiceContext } from '@/server/services/context';

/**
 * Claude (Anthropic) twin of streamChat — SAME signature, SAME event stream,
 * SAME rails as the Gemini loop (bounded hops, parallel tools, <data> scrub,
 * empty-reply forced-text retry, canned tool errors). The chat route picks
 * this or the Gemini loop via resolveAiProvider(); nothing else changes.
 *
 * Tool declarations are reused verbatim: a Gemini FunctionDeclaration's
 * `parameters` is already a JSON Schema (SchemaType values are the lowercase
 * JSON type strings), so it drops straight into Anthropic's `input_schema`.
 */

/** The catalog, converted to Anthropic tool specs (declarations reused as-is). */
function anthropicTools(): Anthropic.Tool[] {
  return toolDeclarations().map((d) => ({
    name: d.name,
    description: d.description ?? '',
    input_schema: (d.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
  }));
}

const MAX_TOKENS = 4096;

/**
 * Anthropic is STRICTER than Gemini about message shape: the first message
 * must be `user`, and no two consecutive messages may share a role. Stored
 * chat history is normally clean user↔assistant alternation, but a stray
 * leading assistant greeting or a double-user turn would 400 the request.
 * Coalesce consecutive same-role turns and drop any leading assistant turn.
 * (Initial history + current message are all plain-string content.)
 */
function normalizeInitialMessages(
  msgs: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    if (out.length === 0 && m.role !== 'user') continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      const prevText = typeof prev.content === 'string' ? prev.content : '';
      const curText = typeof m.content === 'string' ? m.content : '';
      prev.content = `${prevText}\n\n${curText}`.trim();
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export async function* streamChatClaude(
  history: ChatTurn[],
  userMessage: string,
  ctx: ServiceContext,
  opts: { signal?: AbortSignal; snapshot?: string } = {},
): AsyncGenerator<ChatStreamEvent, { reply: string; toolCallsUsed: ToolCallRecord[] }> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Create a key at https://console.anthropic.com and add it to apps/web/.env.local + Vercel project env.',
    );
  }
  const cleanedUserMessage = userMessage?.trim();
  if (!cleanedUserMessage) throw new Error('Empty user message');

  const signal = opts.signal;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const system = opts.snapshot ? `${SYSTEM_PROMPT}\n\n${opts.snapshot}` : SYSTEM_PROMPT;
  const model = env.ANTHROPIC_MODEL;
  const tools = anthropicTools();

  const trimmedHistory =
    history.length > MAX_HISTORY_TURNS ? history.slice(-MAX_HISTORY_TURNS) : history;

  const messages: Anthropic.MessageParam[] = normalizeInitialMessages([
    ...trimmedHistory.map(
      (t): Anthropic.MessageParam => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: t.content,
      }),
    ),
    { role: 'user', content: cleanedUserMessage },
  ]);

  const toolCallsUsed: ToolCallRecord[] = [];
  let assembledReply = '';
  // ONE registry for the whole turn — same rails as the Gemini loop.
  const origins = newTurnOriginRegistry();

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    if (signal?.aborted) throw new Error('aborted');

    const stream = client.messages.stream(
      { model, max_tokens: MAX_TOKENS, system, tools, messages },
      { signal },
    );

    let roundText = '';
    let stopReason: string | null = null;
    // Tool-use blocks accumulate their input JSON across input_json_delta events.
    const toolAccumByIndex = new Map<number, { id: string; name: string; json: string }>();

    for await (const ev of stream) {
      if (signal?.aborted) throw new Error('aborted');
      if (ev.type === 'content_block_start') {
        if (ev.content_block.type === 'tool_use') {
          toolAccumByIndex.set(ev.index, {
            id: ev.content_block.id,
            name: ev.content_block.name,
            json: '',
          });
        }
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') {
          const clean = scrubDataTags(ev.delta.text);
          if (clean.length > 0) {
            roundText += clean;
            yield { type: 'text', delta: clean };
          }
        } else if (ev.delta.type === 'input_json_delta') {
          const acc = toolAccumByIndex.get(ev.index);
          if (acc) acc.json += ev.delta.partial_json;
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      }
    }

    assembledReply += roundText;

    // Parse the tool calls this round emitted, in index order.
    const roundToolCalls = [...toolAccumByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => {
        let args: Record<string, unknown> = {};
        try {
          args = acc.json ? (JSON.parse(acc.json) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        return { id: acc.id, name: acc.name, args };
      });

    if (stopReason !== 'tool_use' || roundToolCalls.length === 0) {
      // Final hop. Same empty-reply recovery as the Gemini loop: if tools ran
      // but the model produced no text, do ONE forced-text retry (tools off).
      if (!assembledReply) {
        if (toolCallsUsed.length > 0) {
          try {
            const forced = client.messages.stream(
              {
                model,
                max_tokens: MAX_TOKENS,
                system: `${system}\n\nThe assistant has already called the necessary tools. DO NOT call more tools. Write the final user-facing answer NOW, grounded in the tool results above. Be concise and factual.`,
                messages,
              },
              { signal },
            );
            for await (const ev of forced) {
              if (signal?.aborted) throw new Error('aborted');
              if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
                const clean = scrubDataTags(ev.delta.text);
                if (clean.length > 0) {
                  assembledReply += clean;
                  yield { type: 'text', delta: clean };
                }
              }
            }
          } catch (err) {
            void reportError(err, { tag: 'ai.empty-fallback-retry.claude' });
          }
        }
        if (!assembledReply) {
          const empty =
            "I ran the lookups but couldn't form a clean answer. Try asking again with a bit more detail.";
          assembledReply = empty;
          yield { type: 'text', delta: empty };
        }
      }
      return { reply: assembledReply, toolCallsUsed };
    }

    const acceptedCalls = roundToolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    const droppedCalls = roundToolCalls.slice(MAX_TOOL_CALLS_PER_ROUND);

    // Echo the assistant turn back verbatim (text + every tool_use block) —
    // Anthropic requires each tool_use to be matched by a tool_result next turn.
    const assistantContent: Anthropic.ContentBlockParam[] = [];
    if (roundText.length > 0) assistantContent.push({ type: 'text', text: roundText });
    for (const call of roundToolCalls) {
      assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    // Run accepted tools in parallel (max-of-tool-times, not sum).
    const settled = await Promise.all(
      acceptedCalls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
        if (signal?.aborted) {
          return { type: 'tool_result', tool_use_id: call.id, content: 'aborted', is_error: true };
        }
        const tool = TOOL_CATALOG[call.name];
        if (!tool) {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Unknown tool: ${call.name}`,
            is_error: true,
          };
        }
        try {
          // Shared boundary with the Gemini loop: arg de-fencing, write
          // refusal on untrusted-quoted args, result fencing, write audit.
          const out = await runWithUntrustedOrigins(origins, () =>
            executeToolCall(tool, call.name, call.args ?? {}, ctx),
          );
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out ?? null) };
        } catch (err) {
          void reportError(err, {
            tag: 'ai.tool.claude',
            extra: { tool: call.name },
            organizationId: ctx.organizationId,
          });
          // Canned safe message — never leak raw DB errors/stack traces.
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: classifyToolErrorMessage(err),
            is_error: true,
          };
        }
      }),
    );

    // Tool-badge timeline in original order.
    for (let i = 0; i < settled.length; i++) {
      const call = acceptedCalls[i]!;
      const ok = settled[i]!.is_error !== true;
      toolCallsUsed.push({ name: call.name, args: call.args, ok });
      yield { type: 'tool', name: call.name, ok };
    }

    // Dropped calls STILL need a tool_result (Anthropic requires one per
    // tool_use) — hand them an error so the model retries with fewer tools.
    const droppedResults: Anthropic.ToolResultBlockParam[] = droppedCalls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: `Exceeded per-round tool-call limit (${MAX_TOOL_CALLS_PER_ROUND}). Retry with fewer tools.`,
      is_error: true,
    }));
    for (const dc of droppedCalls) {
      toolCallsUsed.push({ name: dc.name, args: dc.args, ok: false });
      yield { type: 'tool', name: dc.name, ok: false };
    }

    messages.push({ role: 'user', content: [...settled, ...droppedResults] });
  }

  if (!assembledReply) {
    assembledReply =
      "I tried a few different lookups but couldn't pin down a clean answer. Try asking again with more specifics (e.g. an item name, SKU, or warehouse).";
    yield { type: 'text', delta: assembledReply };
  }
  return { reply: assembledReply, toolCallsUsed };
}
