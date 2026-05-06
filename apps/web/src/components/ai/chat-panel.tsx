'use client';

import {
  Loader2,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ name: string; ok: boolean }>;
}

interface SessionRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

const SUGGESTIONS = [
  "What's below reorder right now?",
  'Show me total inventory value.',
  'Who adjusted stock today?',
  "List warehouses we operate.",
  'Find Hydrapeak water bottles.',
];

const ACTIVE_SESSION_KEY = 'stockpilot.ai.activeSession';

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diffMs = Date.now() - t;
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function ChatPanel() {
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<SessionRow[]>([]);
  const [hydrating, setHydrating] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Load persisted session list + restore active session on mount.
  React.useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const res = await fetch('/api/ai/sessions');
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && json.ok) {
          const list = (json.sessions as SessionRow[]) ?? [];
          setSessions(list);
          const stored =
            typeof window !== 'undefined'
              ? window.localStorage.getItem(ACTIVE_SESSION_KEY)
              : null;
          const target = stored && list.find((s) => s.id === stored) ? stored : null;
          if (target) await loadSession(target);
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [turns, busy]);

  async function refreshSessions() {
    try {
      const res = await fetch('/api/ai/sessions');
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setSessions((json.sessions as SessionRow[]) ?? []);
    } catch {
      // non-fatal — sidebar just won't update until next render
    }
  }

  async function loadSession(id: string) {
    try {
      const res = await fetch(`/api/ai/sessions/${id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        // Stored id is stale (expired or deleted elsewhere). Clear it.
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(ACTIVE_SESSION_KEY);
        }
        setSessionId(null);
        setTurns([]);
        return;
      }
      const messages = (json.messages as Array<{
        role: 'user' | 'assistant';
        content: string;
        toolCalls: Array<{ name: string; ok: boolean }> | null;
      }>) ?? [];
      setSessionId(id);
      setTurns(
        messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls ?? undefined,
        })),
      );
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(ACTIVE_SESSION_KEY, id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load session');
    }
  }

  function startNewChat() {
    setSessionId(null);
    setTurns([]);
    setInput('');
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }

  async function deleteSession(id: string) {
    try {
      const res = await fetch(`/api/ai/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not delete chat');
        return;
      }
      setSessions((cur) => cur.filter((s) => s.id !== id));
      if (id === sessionId) startNewChat();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function send(message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (busy) return;
    const next: ChatTurn[] = [...turns, { role: 'user', content: trimmed }];
    setTurns(next);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          sessionId: sessionId ?? undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        toast.error(json.message || `Chat failed (${res.status})`);
        setTurns((cur) => [
          ...cur,
          {
            role: 'assistant',
            content:
              json.message ||
              "Couldn't reach the assistant. Check that GEMINI_API_KEY is set in your project env, then try again.",
          },
        ]);
        return;
      }
      const newSessionId = (json.sessionId as string | null) ?? null;
      if (newSessionId && newSessionId !== sessionId) {
        setSessionId(newSessionId);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(ACTIVE_SESSION_KEY, newSessionId);
        }
      }
      const toolCalls = (json.toolCallsUsed as Array<{ name: string; ok: boolean }>) ?? [];
      setTurns((cur) => [
        ...cur,
        {
          role: 'assistant',
          content: (json.reply as string) || '(no reply)',
          toolCalls,
        },
      ]);
      void refreshSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-160px)] gap-4">
      {/* Sessions sidebar */}
      <aside className="border-border bg-card hidden w-56 shrink-0 flex-col rounded-xl border p-2 md:flex">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={startNewChat}
          className="mb-2 justify-start gap-2"
        >
          <Plus className="h-3.5 w-3.5" />
          New chat
        </Button>
        <p className="text-muted-foreground mb-1 px-2 text-[10px] font-medium uppercase tracking-wider">
          Last 30 days
        </p>
        <div className="-mx-1 flex-1 overflow-y-auto px-1">
          {hydrating ? (
            <div className="text-muted-foreground px-2 py-3 text-[12px]">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="text-muted-foreground px-2 py-3 text-[12px]">No chats yet.</div>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => (
                <li key={s.id} className="group">
                  <div
                    className={cn(
                      'flex items-center gap-1 rounded-md px-2 py-1.5 text-[12.5px]',
                      s.id === sessionId
                        ? 'bg-foreground/[0.06] text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void loadSession(s.id)}
                      className="flex min-w-0 flex-1 flex-col text-left"
                    >
                      <span className="truncate">
                        {s.title || 'Untitled chat'}
                      </span>
                      <span className="text-muted-foreground text-[10px]">
                        {formatRelative(s.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteSession(s.id);
                      }}
                      className="text-muted-foreground hover:text-destructive opacity-0 transition group-hover:opacity-100"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Chat column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto pb-4"
          aria-live="polite"
        >
          {turns.length === 0 ? (
            <div className="mx-auto max-w-md py-12 text-center">
              <div className="bg-muted text-muted-foreground mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full">
                <Sparkles className="h-4 w-4" />
              </div>
              <h2 className="text-lg font-medium">Ask your inventory anything</h2>
              <p className="text-muted-foreground mt-1.5 text-sm">
                Read-only for now. Powered by Gemini 2.0 Flash with tool calls
                into your real data — no hallucinated quantities.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    disabled={busy}
                    className="border-border bg-card hover:border-foreground/30 rounded-full border px-3 py-1.5 text-[12px] disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ul className="space-y-4">
              {turns.map((t, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex',
                    t.role === 'user' ? 'justify-end' : 'justify-start',
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                      t.role === 'user'
                        ? 'bg-foreground text-background rounded-br-md'
                        : 'bg-muted text-foreground rounded-bl-md',
                    )}
                  >
                    <div className="whitespace-pre-wrap">{t.content}</div>
                    {t.toolCalls && t.toolCalls.length > 0 && (
                      <div className="text-muted-foreground mt-2 flex flex-wrap gap-1.5 text-[10.5px]">
                        {t.toolCalls.map((tc, j) => (
                          <span
                            key={j}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full border px-1.5 py-px',
                              tc.ok
                                ? 'border-success/40 bg-success/10 text-success'
                                : 'border-destructive/40 bg-destructive/10 text-destructive',
                            )}
                          >
                            <Wrench className="h-2.5 w-2.5" />
                            {tc.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
              {busy && (
                <li className="flex justify-start">
                  <div className="bg-muted text-muted-foreground inline-flex items-center gap-2 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    thinking…
                  </div>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="border-border bg-card flex items-end gap-2 rounded-xl border p-2 shadow-sm"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask about your stock, suppliers, or recent activity…"
            rows={1}
            className="placeholder:text-muted-foreground max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
            disabled={busy}
            aria-label="Ask the inventory assistant"
          />
          <Button
            type="submit"
            variant="gradient"
            size="sm"
            disabled={busy || input.trim().length === 0}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
        </form>
        <p className="text-muted-foreground mt-1.5 px-1 text-[10.5px]">
          ⌘ Enter or Enter to send · Shift+Enter for newline · Chats auto-save for 30 days.
        </p>
      </div>
    </div>
  );
}
