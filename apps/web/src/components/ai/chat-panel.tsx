'use client';

import { Loader2, Send, Sparkles, Wrench } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ name: string; ok: boolean }>;
}

const SUGGESTIONS = [
  "What's below reorder right now?",
  'Show me total inventory value.',
  'Who adjusted stock today?',
  "List warehouses we operate.",
  'Find Hydrapeak water bottles.',
];

export function ChatPanel() {
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    // Stick to the bottom on new turns.
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [turns, busy]);

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
          history: turns.map((t) => ({ role: t.role, content: t.content })),
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
      const toolCalls = (json.toolCallsUsed as Array<{ name: string; ok: boolean }>) ?? [];
      setTurns((cur) => [
        ...cur,
        {
          role: 'assistant',
          content: (json.reply as string) || '(no reply)',
          toolCalls,
        },
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-160px)] flex-col">
      {/* Message list */}
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
        ⌘ Enter or Enter to send · Shift+Enter for newline · Read-only;
        responses stream from Gemini 2.0 Flash with structured tool calls.
      </p>
    </div>
  );
}
