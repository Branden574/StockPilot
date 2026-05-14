import 'server-only';

import type { ServiceContext } from '@/server/services/context';

/**
 * Chat session/message persistence for the AI assistant. Sessions are
 * scoped to (organization, user) — RLS enforces this — and are reaped
 * after 30 days of inactivity by the `purge_ai_chat_history()` SQL
 * function (see migration 0030).
 *
 * The chat route persists both turns (user input + assistant reply)
 * after a successful response so partial/failed turns don't leave
 * orphaned messages in history.
 */

const RETENTION_DAYS = 30;

export interface ChatSessionRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: Array<{ name: string; ok: boolean }> | null;
  createdAt: string;
}

function retentionCutoffISO(): string {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function listSessions(ctx: ServiceContext): Promise<ChatSessionRow[]> {
  // !inner forces an INNER JOIN against ai_chat_messages, so sessions
  // with zero messages get filtered out at the DB layer. This keeps
  // any leftover orphan rows (created before the lazy-create fix
  // landed) from cluttering the sidebar — they'll auto-purge after
  // 30 days via purge_ai_chat_history().
  const { data, error } = await ctx.supabase
    .from('ai_chat_sessions')
    .select('id, title, created_at, updated_at, ai_chat_messages!inner(id)')
    .eq('organization_id', ctx.organizationId)
    .eq('user_id', ctx.userId)
    .gte('updated_at', retentionCutoffISO())
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  // Dedupe — the inner join can return one row per matching message;
  // we want one row per session.
  const seen = new Set<string>();
  const out: ChatSessionRow[] = [];
  for (const r of ((data ?? []) as Array<{
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
  }>)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

export async function createSession(
  ctx: ServiceContext,
  title?: string | null,
): Promise<ChatSessionRow> {
  const { data, error } = await ctx.supabase
    .from('ai_chat_sessions')
    .insert({
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
      title: title ?? null,
    })
    .select('id, title, created_at, updated_at')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'create_session_failed');
  const row = data as {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
  };
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Result of {@link deleteSession}. `ok=false` means no row matched the
 * (id, user, org) tuple — likely a cross-user attempt, a typo, or a
 * row already purged by the 30-day cron. The caller turns this into a
 * 404 instead of a silent 200.
 */
export interface DeleteSessionResult {
  ok: boolean;
}

export async function deleteSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<DeleteSessionResult> {
  // RLS already restricts to (user_id, organization_id) but we ALSO
  // ask PostgREST to RETURN the deleted row's id — that way a request
  // that matched zero rows (cross-user, stale id, etc.) surfaces as
  // an empty array and we can 404 properly instead of cheerfully
  // claiming success.
  const { data, error } = await ctx.supabase
    .from('ai_chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', ctx.userId)
    .eq('organization_id', ctx.organizationId)
    .select('id');
  if (error) throw new Error(error.message);
  return { ok: Array.isArray(data) && data.length > 0 };
}

/**
 * Verifies the caller owns the session and returns it. Returns null
 * when no row matches — RLS would also block, but an explicit check
 * lets the API return 404 vs 500 cleanly.
 *
 * Cosmetic race note: if a session is deleted between the moment a
 * request reads it via getSession and the moment `appendMessages`
 * inserts new turns, the insert will fail at the FK and the caller
 * throws. That's fine — RLS + FK keep us safe; the user just sees
 * "couldn't save chat" instead of a phantom message. Not worth a
 * cross-request transaction for v1.
 */
export async function getSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<ChatSessionRow | null> {
  const { data } = await ctx.supabase
    .from('ai_chat_sessions')
    .select('id, title, created_at, updated_at')
    .eq('id', sessionId)
    .eq('user_id', ctx.userId)
    .eq('organization_id', ctx.organizationId)
    .gte('updated_at', retentionCutoffISO())
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
  };
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Hard cap on how many messages we ever load from a session. Long-lived
 * sessions can accumulate hundreds of turns; the chat route only needs
 * the most recent slice for context, and we also can't blow past
 * Gemini's prompt budget. 60 messages == ~30 turns == well under a
 * 1M-token window on modern Gemini models. The route applies its own
 * 40-turn cap on top of this.
 */
const MAX_LOADED_MESSAGES = 60;

export async function listMessages(
  ctx: ServiceContext,
  sessionId: string,
): Promise<ChatMessageRow[]> {
  // Fetch the NEWEST MAX_LOADED_MESSAGES, then reverse so the caller
  // still gets chronological (oldest-first) order. Doing it this way
  // means we never materialize a 1000-row history just to throw most
  // of it away — the LIMIT is applied at the DB layer.
  const { data, error } = await ctx.supabase
    .from('ai_chat_messages')
    .select('id, role, content, tool_calls, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(MAX_LOADED_MESSAGES);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    tool_calls: Array<{ name: string; ok: boolean }> | null;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls,
    createdAt: r.created_at,
  }));
  // Reverse in-place — cheaper than another allocation and the array
  // is already at-most MAX_LOADED_MESSAGES long.
  return rows.reverse();
}

export async function appendMessages(
  ctx: ServiceContext,
  sessionId: string,
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: Array<{ name: string; ok: boolean }> | null;
  }>,
): Promise<void> {
  if (messages.length === 0) return;
  const rows = messages.map((m) => ({
    session_id: sessionId,
    role: m.role,
    content: m.content,
    tool_calls: m.toolCalls ?? null,
  }));
  const { error } = await ctx.supabase.from('ai_chat_messages').insert(rows);
  if (error) throw new Error(error.message);
}

/**
 * Derives a short title from the user's first message — used so the
 * sessions list shows something more useful than "Untitled". Trims to
 * 60 chars and strips trailing punctuation/whitespace.
 */
export function deriveTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.trim().replace(/\s+/g, ' ');
  const cut = cleaned.length > 60 ? `${cleaned.slice(0, 57).trimEnd()}…` : cleaned;
  return cut.replace(/[\s.?!]+$/, '');
}
