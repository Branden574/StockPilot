import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/lib/env';

/**
 * One-shot Claude helpers for the NON-chat generative surfaces — photo ID,
 * shelf scan, PO scan, ISBN extract, UPC/book lookup, insights narrative.
 * The chat agent loop lives in chat-claude.ts; this file is the request/reply
 * (single turn) counterpart.
 *
 * Structured output uses a FORCED single-tool call (tool_choice) rather than a
 * "return JSON" instruction — Anthropic has no responseSchema, and forcing a
 * tool whose input_schema is the desired shape is the reliable equivalent.
 * A Gemini responseSchema (SchemaType.OBJECT/STRING/… whose enum values are
 * the lowercase JSON-Schema type strings) drops straight in as input_schema.
 *
 * Callers gate on resolveAiProvider() (lib/ai/provider.ts) before calling
 * these — so with no ANTHROPIC_API_KEY the Gemini path runs unchanged.
 */

/** A base64-encoded image or PDF input. mediaType e.g. 'image/jpeg', 'application/pdf'. */
export interface ClaudeMedia {
  data: string;
  mediaType: string;
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function requireClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot use the Claude provider.');
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/** Build a user content array: media blocks first, then the text prompt. Exported for tests. */
export function userContent(prompt: string, media?: ClaudeMedia[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const m of media ?? []) {
    if (m.mediaType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: m.data },
      });
    } else if (IMAGE_MEDIA_TYPES.has(m.mediaType)) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: m.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: m.data,
        },
      });
    } else {
      // Unknown image subtype (e.g. image/heic) — Claude's vision only accepts
      // jpeg/png/gif/webp. Coerce the label to jpeg; the bytes usually decode.
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: m.data },
      });
    }
  }
  blocks.push({ type: 'text', text: prompt });
  return blocks;
}

/** Free-text (narrative) generation. Returns the concatenated, trimmed text. */
export async function claudeGenerateText(opts: {
  prompt: string;
  system?: string;
  media?: ClaudeMedia[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const msg = await requireClient().messages.create(
    {
      model: env.ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: userContent(opts.prompt, opts.media) }],
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Structured (JSON) generation via a forced tool call. `schema` is a JSON
 * Schema object (a Gemini responseSchema works verbatim). Returns the parsed
 * object — the model is constrained to the schema, so no fragile text parsing.
 */
export async function claudeGenerateJson<T = unknown>(opts: {
  prompt: string;
  schema: object;
  system?: string;
  media?: ClaudeMedia[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Override the model for THIS call (e.g. the PO-scan escalation model).
   *  Defaults to ANTHROPIC_MODEL. Newer models (sonnet-5+) reject
   *  `temperature` — callers overriding to one of those must omit it. */
  model?: string;
}): Promise<T> {
  const msg = await requireClient().messages.create(
    {
      model: opts.model ?? env.ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      tools: [
        {
          name: 'emit_result',
          description: 'Return the structured result. This is the ONLY output.',
          input_schema: opts.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_result' },
      messages: [{ role: 'user', content: userContent(opts.prompt, opts.media) }],
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );
  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!block) throw new Error('Claude returned no structured output.');
  return block.input as T;
}

/**
 * Same as claudeGenerateJson but returns the JSON as a STRING, so callers that
 * already own their own `JSON.parse(...) + validate` step can swap only the
 * "get raw model text" line and keep every downstream check intact.
 */
export async function claudeGenerateJsonString(opts: {
  prompt: string;
  schema: object;
  system?: string;
  media?: ClaudeMedia[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** See claudeGenerateJson.model. */
  model?: string;
}): Promise<string> {
  return JSON.stringify(await claudeGenerateJson(opts));
}
