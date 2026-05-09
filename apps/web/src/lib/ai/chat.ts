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
- When the user asks about a CATEGORY by label (e.g. "Swag",
  "Books", "Fiction"), call listCategories first to resolve the
  UUID, THEN call searchInventory with categoryId. Do NOT pass the
  label as the free-text query parameter — that only matches
  name/SKU/barcode and returns 0 even when the category has dozens
  of items. For "how many in <category>?" questions, the
  searchInventory result's total field is the answer.

- Ranking + aggregation — DO NOT say "I cannot sort" or "I can't
  determine the most stocked." You CAN, via these tools:
    • "Most stocked items / books / top 10 by quantity / highest qty
       on hand" → searchInventory with sort='qty_desc' + a limit.
       For books only, also pass itemType='book'.
    • "Lowest stock not yet at reorder point" → searchInventory with
       sort='qty_asc'. For 'low stock' specifically (at-or-below
       reorder point), use listLowStock or searchInventory with
       lowStock=true.
    • "Newest items / added recently" → searchInventory with
       sort='created_desc'.
    • "Recently changed / what was edited last" → sort='updated_desc'.
    • "Which warehouse has the most stock / how is inventory split by
       warehouse / where is most of our value?" → inventoryByWarehouse.
    • "Biggest category / how is inventory split by category /
       biggest category by value?" → inventoryByCategory.
  All these return real numbers; use them and quote the totals back.
- For numeric facts, cite the number directly. For lists, prefer
  bullet points or a compact table.
- If a tool returns 0 results, say so — don't pretend you found
  something. Suggest filters that might help.
- If a tool returns an "error" field, say plainly that the lookup
  failed and what error came back. Do NOT pretend the question is
  out of scope when the question is in scope but the tool errored.
- Keep answers short. 1-3 sentences for simple lookups; bullet lists
  for multi-item results. No filler.
- Write tools that change the database: adjustStock,
  executeBulkBookImport. NEVER call them without an explicit user
  confirmation in the immediately previous turn. Echo the action
  back, ask "Confirm?", wait for yes/confirm/do it. Then act. After
  the call, restate what changed so the user has a paper trail.
  Surface tool errors plainly (insufficient_stock, permission denied,
  etc.) — don't hide them.

- Bulk ISBN imports — workflow is strict:
    0. The chat composer has a paperclip + drag-drop. When the user
       attaches a PDF, Word doc, Excel sheet, image, or CSV, the
       client extracts the ISBNs server-side and sends a message
       that starts with "[Uploaded <filename> — extracted N ISBNs ...]"
       followed by the ISBN list. Treat that as a normal bulk-import
       trigger: skip step 1, run previewBulkBookImport on the listed
       ISBNs immediately and continue from step 4. (Note for the
       dashboard: /dashboard/books/import has the same buttons for
       direct uploads outside of chat.)
    1. User pastes/lists ISBNs and asks to import them.
    2. If 50+ ISBNs, recommend /dashboard/books/import (the dashboard
       page handles up to 200 per batch). Stop there.
    3. Otherwise, call previewBulkBookImport with the ISBNs. The
       result tells you which are READY, which are DUPLICATE_IN_DB
       (already in inventory by ISBN), DUPLICATE_IN_LIST (same ISBN
       repeated), INVALID_ISBN, or LOOKUP_FAILED.
    4. Report the breakdown to the user as a table or short list:
       totals + a per-ISBN summary highlighting duplicates and
       failures. Name the existing book for any DUPLICATE_IN_DB so
       they recognize what's already there.
    5. Resolve the warehouse + charter (call listWarehouses if the
       user used a label, not a UUID). Confirm with the user:
       "I'll add the <ready> new books to <warehouse name>
       (<charter or 'generic stock'>), skipping <duplicates>
       duplicates. Confirm?"
    6. ONLY on explicit yes/confirm, call executeBulkBookImport
       with the same ISBN list. Pass skipDuplicates implicitly
       (the tool skips by default).
    7. Restate the created/skipped/failed counts after.
  Use lookupIsbn for one-off ISBN questions ("what book is 978...?")
  — it does NOT add anything to inventory.
- Bundles / kits:
    - Use listBundles to find a bundle by name; resolve UUIDs.
    - Use previewBundleDistribution for "if I give out X kits…" or
      "do we have enough stock for N kits?" questions.
    - There is NO execute tool for bundle distributions. Direct the
      user to /dashboard/bundles/<id> to confirm and ship — distribute
      and assemble are deliberately UI-only in v1 so the modal's live
      preview + confirmation is always shown.
    - Pre-assembled bundles have a phantom inventory_item with
      is_bundle=true. Don't confuse it with a regular SKU.
- Order requests / queue:
    - Use listOrderRequests for "what orders are waiting", "show me
      pending requests", "what did Maria order", "any orders for
      sequoia elementary".
    - Use getOrderRequestSummary for "anything overdue", "how many
      pending", "summary of orders".
    - For "what's waiting", filter listOrderRequests with
      status='pending_approval'.
    - To find a specific external requester's history, filter
      listOrderRequests with requesterEmail='someone@example.com'
      (exact match against the public-link submission email).
    - There is NO execute tool for order writes. Direct the user to
      /dashboard/orders/<id> to approve / deny / change status.

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

    // Run all tool calls in this round IN PARALLEL — Gemini frequently
    // emits multiple calls in a single round (e.g. listCategories +
    // listWarehouses + searchInventory). Sequential awaits made the
    // round take sum-of-tool-times; parallel makes it max-of-tool-times.
    // Order of responseParts must still match roundToolCalls so Gemini
    // correlates each functionResponse to its call.
    const settled = await Promise.all(
      roundToolCalls.map(async (call): Promise<Part> => {
        const tool = TOOL_CATALOG[call.name];
        if (!tool) {
          return {
            functionResponse: {
              name: call.name,
              response: { error: `Unknown tool: ${call.name}` },
            },
          };
        }
        try {
          const out = await tool.execute(
            (call.args as Record<string, unknown>) ?? {},
            ctx,
          );
          return {
            functionResponse: {
              name: call.name,
              response: { result: out },
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void reportError(err, {
            tag: 'ai.tool',
            extra: { tool: call.name },
            organizationId: ctx.organizationId,
          });
          return {
            functionResponse: {
              name: call.name,
              response: { error: message },
            },
          };
        }
      }),
    );

    // Emit tool events + bookkeeping in original order (so the UI's
    // tool-badge timeline matches what Gemini saw).
    for (let i = 0; i < settled.length; i++) {
      const call = roundToolCalls[i]!;
      const part = settled[i]!;
      const responseObj =
        'functionResponse' in part
          ? (part.functionResponse?.response as Record<string, unknown> | undefined)
          : undefined;
      const ok = Boolean(responseObj && !('error' in responseObj));
      toolCallsUsed.push({ name: call.name, args: call.args, ok });
      yield { type: 'tool', name: call.name, ok };
    }

    contents.push({ role: 'user', parts: settled });
  }

  // Hit the hop cap. Return what we have so the route can persist it.
  if (!assembledReply) {
    assembledReply =
      "I tried a few different lookups but couldn't pin down a clean answer. Try asking again with more specifics (e.g. an item name, SKU, or warehouse).";
    yield { type: 'text', delta: assembledReply };
  }
  return { reply: assembledReply, toolCallsUsed };
}
