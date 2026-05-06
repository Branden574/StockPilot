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
  const { data, error } = await ctx.supabase
    .from('ai_chat_sessions')
    .select('id, title, created_at, updated_at')
    .eq('organization_id', ctx.organizationId)
    .eq('user_id', ctx.userId)
    .gte('updated_at', retentionCutoffISO())
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
  }>).map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
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

export async function deleteSession(ctx: ServiceContext, sessionId: string): Promise<void> {
  const { error } = await ctx.supabase
    .from('ai_chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', ctx.userId)
    .eq('organization_id', ctx.organizationId);
  if (error) throw new Error(error.message);
}

/**
 * Verifies the caller owns the session and returns it. Returns null
 * when no row matches — RLS would also block, but an explicit check
 * lets the API return 404 vs 500 cleanly.
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

export async function listMessages(
  ctx: ServiceContext,
  sessionId: string,
): Promise<ChatMessageRow[]> {
  const { data, error } = await ctx.supabase
    .from('ai_chat_messages')
    .select('id, role, content, tool_calls, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
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
