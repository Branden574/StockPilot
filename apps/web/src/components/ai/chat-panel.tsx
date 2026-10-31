'use client';

import { Loader2, Paperclip, Plus, Send, Sparkles, Trash2, Wrench } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { filterChipClass } from '@/components/patterns/chip';
import { StatePanel } from '@/components/patterns/state-panel';
import { touchTargetClass } from '@/components/patterns/touch-target';
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

/** Generic prompts shown when we can't infer a more specific context
 *  (e.g. user opened the AI assistant directly without coming from a
 *  detail page). */
const DEFAULT_SUGGESTIONS = [
  "What's below reorder right now?",
  'Show me total inventory value.',
  'Who adjusted stock today?',
  'List warehouses we operate.',
  'Find water bottles.',
];

/**
 * Pick the chip prompts to surface in the empty-state. When the user
 * arrives at the chat from a known dashboard route (the referrerPath
 * captured in the effect above), we swap the generic chips for ones
 * tailored to that surface — turns "ask your inventory anything"
 * from a blank page into "here's what's useful from THIS page."
 *
 * The chips are sent verbatim into the chat as the user message, so
 * the AI's existing PAGE CONTEXT block (Phase 2) takes care of
 * resolving "this order" / "this item" to the on-page UUID. We don't
 * need to bake the UUID into the chip text.
 */
function pickSuggestions(referrerPath: string | null): string[] {
  if (!referrerPath) return DEFAULT_SUGGESTIONS;
  // Order detail
  if (/^\/dashboard\/orders\/[0-9a-f-]{36}/i.test(referrerPath)) {
    return [
      "What's the next action for this order?",
      'Who is assigned to pick this?',
      'Show the timeline for this order.',
      'Why is this order stuck?',
      'Cancel this order.',
    ];
  }
  // Orders list
  if (/^\/dashboard\/orders(\/?$|\?)/.test(referrerPath)) {
    return [
      "What's pending approval?",
      'Are any orders overdue?',
      'Summary of orders today.',
      'Which orders are staged for delivery?',
    ];
  }
  // Inventory item detail (incl. books detail)
  if (/^\/dashboard\/(inventory|books)\/[0-9a-f-]{36}/i.test(referrerPath)) {
    return [
      "What's the on-hand for this item?",
      'Show recent movements for this item.',
      'When was this last received?',
      'Is this below reorder point?',
    ];
  }
  // Inventory list
  if (/^\/dashboard\/inventory(\/?$|\?)/.test(referrerPath)) {
    return [
      "What's below reorder right now?",
      'Show the 10 most-stocked items.',
      "Which items haven't moved in 90 days?",
      'Show me items added this week.',
    ];
  }
  // Books list
  if (/^\/dashboard\/books(\/?$|\?)/.test(referrerPath)) {
    return [
      'How many copies of each book do we have?',
      'Which books are low stock?',
      'List books by grade level.',
      'Show recent book additions.',
    ];
  }
  // Purchase orders
  if (/^\/dashboard\/purchase-orders/.test(referrerPath)) {
    return [
      "What's overdue on POs?",
      'Show recent receipts.',
      "Which POs haven't been received yet?",
      'Summary of open POs.',
    ];
  }
  // Cycle counts
  if (/^\/dashboard\/cycle-counts/.test(referrerPath)) {
    return [
      "What's the variance on the latest count?",
      'Show counts in progress.',
      'Which items had discrepancies?',
    ];
  }
  // Dashboard overview
  if (referrerPath === '/dashboard' || referrerPath === '/dashboard/') {
    return [
      'What needs my attention today?',
      "What's pending approval?",
      'Show the busiest movement days.',
      'Top 10 most-stocked items.',
    ];
  }
  return DEFAULT_SUGGESTIONS;
}

/**
 * Map a tool name to a "jump to dashboard" link the user can click
 * after the assistant answers. Only surfaces when the tool succeeded
 * and the destination genuinely matches what the tool reported on —
 * keeps the action area uncluttered with stale links.
 *
 * Returns at most one link per turn (the most relevant tool wins).
 * Order matters: writes > specific lists > broad lists.
 */
export function jumpLinkFor(
  toolCalls: ReadonlyArray<{ name: string; ok: boolean }> | undefined,
): { label: string; href: string } | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  const ok = toolCalls.filter((t) => t.ok).map((t) => t.name);
  const names = new Set(ok);
  // Most actionable first. The first match wins.
  if (names.has('approveOrder') || names.has('denyOrder') || names.has('cancelOrder'))
    return { label: 'Open orders dashboard', href: '/dashboard/orders' };
  if (names.has('adjustStock'))
    return { label: 'Open movements log', href: '/dashboard/movements' };
  if (names.has('executeBulkBookImport') || names.has('previewBulkBookImport'))
    return { label: 'Open books', href: '/dashboard/books' };
  if (names.has('getOrderRequestSummary') || names.has('listOrderRequests'))
    return { label: 'Open orders', href: '/dashboard/orders' };
  if (names.has('listLowStock'))
    // The Items page reads `stock` (and `type=all` keeps books in the list),
    // the same link the low-stock notifications use; `?filter=low_stock` was
    // never read, so it opened the unfiltered list (CONFLICTS D4).
    return { label: 'Open low-stock list', href: '/dashboard/inventory?stock=low&type=all' };
  if (names.has('inventoryByWarehouse'))
    return { label: 'Open warehouses', href: '/dashboard/admin/warehouses' };
  if (names.has('inventoryByCategory'))
    return { label: 'Open categories', href: '/dashboard/categories' };
  if (names.has('listBundles') || names.has('previewBundleDistribution'))
    return { label: 'Open bundles', href: '/dashboard/bundles' };
  if (names.has('listSuppliers')) return { label: 'Open suppliers', href: '/dashboard/suppliers' };
  if (names.has('listWarehouses'))
    return { label: 'Open warehouses', href: '/dashboard/admin/warehouses' };
  if (names.has('searchInventorySemantic') || names.has('searchInventory'))
    return { label: 'Open inventory', href: '/dashboard/inventory' };
  if (names.has('getRecentOrders')) return { label: 'Open orders', href: '/dashboard/orders' };
  if (
    names.has('getMovements') ||
    names.has('getRecentItems') ||
    names.has('getDailyMovementCounts')
  )
    return { label: 'Open movements log', href: '/dashboard/movements' };
  if (names.has('getTopMovers') || names.has('getStaleItems'))
    return { label: 'Open reports', href: '/dashboard/reports' };
  if (names.has('getDashboardSummary')) return { label: 'Open dashboard', href: '/dashboard' };
  return null;
}

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
  const [uploading, setUploading] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<SessionRow[]>([]);
  // Capture the dashboard page the user came from once on mount, then
  // ship it as `pageContext.referrerPath` on every chat turn. The
  // server extracts an entity ID from a strict route allowlist
  // (orders/inventory/books/POs/etc.) and uses it to disambiguate
  // questions like "what's next for this order?" without making the
  // user repaste the UUID. Cleared if the user starts a new chat —
  // a new chat is a fresh intent, the prior page is no longer
  // necessarily what they want to talk about.
  const [referrerPath, setReferrerPath] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    try {
      const ref = document.referrer;
      if (!ref) return;
      const url = new URL(ref);
      // Only honor same-origin referrers — otherwise a malicious
      // off-site referer header could try to smuggle paths into the
      // prompt. window.location.origin matches the current dashboard.
      if (url.origin !== window.location.origin) return;
      if (!url.pathname.startsWith('/dashboard/')) return;
      // Avoid the trivial "came from /dashboard/ai itself" case.
      if (url.pathname.startsWith('/dashboard/ai')) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads document.referrer (an external value) once on mount
      setReferrerPath(url.pathname);
    } catch {
      // Ignore — referrer parsing failed, no context will be sent.
    }
  }, []);
  const [hydrating, setHydrating] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Load persisted session list + restore active session on mount.
  //
  // Deliberate stale-closure: `loadSession` is omitted from the deps
  // array on purpose. We only want this effect to run ONCE on mount —
  // adding loadSession would re-fire the bootstrap every render
  // (loadSession is a new function instance each render), re-fetching
  // the session list and racing with the user's first prompt. The
  // closure captures the initial loadSession, which is fine: that
  // function reads the latest `sessionId` via setSessionId, and
  // localStorage carries the active session across renders.
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
            typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_SESSION_KEY) : null;
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
      const messages =
        (json.messages as Array<{
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
      toast.error(
        err instanceof Error
          ? err.message
          : "Couldn't load that chat session. Try again or pick a different one.",
      );
    }
  }

  function startNewChat() {
    setSessionId(null);
    setTurns([]);
    setInput('');
    // A fresh chat is a fresh intent — the page they originally came
    // from is no longer necessarily what they want to talk about. Drop
    // the referrer hint so the AI doesn't keep biasing its answers
    // toward the previous order/item.
    setReferrerPath(null);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }

  async function deleteSession(id: string) {
    try {
      const res = await fetch(`/api/ai/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error("Couldn't delete this chat. Try again in a moment.");
        return;
      }
      setSessions((cur) => cur.filter((s) => s.id !== id));
      if (id === sessionId) startNewChat();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't delete this chat. Try again in a moment.",
      );
    }
  }

  /**
   * Hand a file to the books-extract-isbns-ai endpoint, then auto-send
   * a chat message containing the ISBN list. The AI sees the same
   * format every time, recognizes it as a bulk-import trigger via the
   * system prompt, and proceeds to call previewBulkBookImport.
   */
  async function uploadFile(file: File) {
    if (uploading || busy) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/books/extract-isbns-ai', {
        method: 'POST',
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        isbns?: string[];
        notes?: string;
        message?: string;
      };
      if (!res.ok || !json.ok) {
        toast.error(
          json.message ?? `Couldn't read "${file.name}" (${res.status}). Try a different file.`,
        );
        return;
      }
      const isbns = json.isbns ?? [];
      if (isbns.length === 0) {
        toast.warning(`No ISBNs found in "${file.name}".`);
        return;
      }
      const synthetic = [
        `[Uploaded ${file.name} — extracted ${isbns.length} ISBN${isbns.length === 1 ? '' : 's'}${
          json.notes ? ` (${json.notes})` : ''
        }]`,
        '',
        ...isbns,
        '',
        'Please preview the bulk import for these ISBNs and tell me which warehouse + charter you need.',
      ].join('\n');
      // setUploading off before send() to avoid the disabled-textarea
      // race; send() flips its own busy flag.
      setUploading(false);
      await send(synthetic);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Couldn't upload the file. Check your network and try again.",
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function send(message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (busy) return;
    // Push the user turn AND a placeholder assistant turn — the
    // placeholder is what we mutate as text deltas stream in. The
    // index of the assistant turn in the array stays stable across
    // re-renders because we always push to the end.
    setTurns((cur) => [
      ...cur,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '', toolCalls: [] },
    ]);
    setInput('');
    setBusy(true);

    const appendAssistantDelta = (delta: string) => {
      setTurns((cur) => {
        const last = cur[cur.length - 1];
        if (!last || last.role !== 'assistant') return cur;
        const updated: ChatTurn = { ...last, content: last.content + delta };
        return [...cur.slice(0, -1), updated];
      });
    };

    const pushAssistantTool = (name: string, ok: boolean) => {
      setTurns((cur) => {
        const last = cur[cur.length - 1];
        if (!last || last.role !== 'assistant') return cur;
        const updated: ChatTurn = {
          ...last,
          toolCalls: [...(last.toolCalls ?? []), { name, ok }],
        };
        return [...cur.slice(0, -1), updated];
      });
    };

    const replaceAssistantWithError = (msg: string) => {
      setTurns((cur) => {
        const last = cur[cur.length - 1];
        if (!last || last.role !== 'assistant') {
          return [...cur, { role: 'assistant', content: msg }];
        }
        return [...cur.slice(0, -1), { ...last, content: msg, toolCalls: [] }];
      });
    };

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          sessionId: sessionId ?? undefined,
          // Page context — only sent when we captured a same-origin
          // dashboard referrer at mount. Server parses it against an
          // allowlist; anything outside the allowlist is dropped.
          pageContext: referrerPath ? { referrerPath } : undefined,
        }),
      });

      // Validation/auth errors come back as plain JSON 4xx (no stream).
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        const friendly =
          json.message ?? 'The AI assistant ran into a problem. Try again in a moment.';
        toast.error(friendly);
        replaceAssistantWithError(friendly);
        return;
      }

      if (!res.body) {
        replaceAssistantWithError('No response stream from the assistant.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let streamErrored = false;
      // Track whether the stream actually produced visible content.
      // If it didn't and didn't error either (e.g. model emitted only
      // tool calls and finished with empty text, or Gemini returned
      // zero parts), we still need to put SOMETHING in the bubble so
      // the user isn't staring at a blank reply.
      let receivedText = false;
      let receivedTool = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let event: {
            type?: string;
            delta?: string;
            name?: string;
            ok?: boolean;
            sessionId?: string;
            message?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === 'text' && typeof event.delta === 'string') {
            if (event.delta.length > 0) receivedText = true;
            appendAssistantDelta(event.delta);
          } else if (event.type === 'tool' && typeof event.name === 'string') {
            receivedTool = true;
            pushAssistantTool(event.name, Boolean(event.ok));
          } else if (event.type === 'done' && typeof event.sessionId === 'string') {
            const newSessionId = event.sessionId;
            if (newSessionId !== sessionId) {
              setSessionId(newSessionId);
              if (typeof window !== 'undefined') {
                window.localStorage.setItem(ACTIVE_SESSION_KEY, newSessionId);
              }
            }
          } else if (event.type === 'error') {
            streamErrored = true;
            const friendly =
              event.message ?? 'The AI assistant ran into a problem. Try again in a moment.';
            toast.error(friendly);
            replaceAssistantWithError(friendly);
          }
        }
      }

      // Failsafe: stream finished cleanly but the assistant turn is
      // still empty. Most often this means Gemini called one or more
      // tools and then produced a zero-length final answer (silent
      // tool-loop dead-end). Fill the bubble with a clear "no answer"
      // message so the UI doesn't leave an empty turn hanging.
      if (!streamErrored && !receivedText) {
        const fallback = receivedTool
          ? "I ran the lookups for that but didn't get back a clean answer to share. Try rephrasing or asking for something more specific."
          : "I didn't get a response that time. Try sending the message again.";
        replaceAssistantWithError(fallback);
      }

      if (!streamErrored) void refreshSessions();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Couldn't reach the assistant. Check your network and try again.";
      toast.error(msg);
      replaceAssistantWithError(msg);
    } finally {
      setBusy(false);
    }
  }

  const newChatButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={startNewChat}
      className="justify-start gap-2"
    >
      <Plus className="h-3.5 w-3.5" />
      New chat
    </Button>
  );

  return (
    // dvh handles mobile address bar resize cleanly. The 260px subtract
    // budgets for: dashboard topbar (~64), page wrapper top padding,
    // page header block (~140), bottom breathing room (~24). min-h
    // keeps the panel usable on short viewports.
    <div className="flex h-[calc(100dvh-260px)] min-h-[420px] gap-4">
      {/* Sessions rail: the two-pane tool page's list (md and wider). */}
      <aside className="border-border bg-card hidden w-60 shrink-0 flex-col overflow-hidden rounded-lg border md:flex">
        <div className="border-border flex flex-col border-b p-2">{newChatButton}</div>
        <p className="text-muted-foreground px-3.5 pb-1 pt-3 text-[11px] font-medium uppercase leading-4 tracking-[0.08em]">
          Last 30 days
        </p>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2">
          {hydrating ? (
            <div className="text-muted-foreground px-2 py-3 text-[12.5px]">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="text-muted-foreground px-2 py-3 text-[12.5px]">No chats yet.</div>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => {
                const active = s.id === sessionId;
                return (
                  <li key={s.id} className="group">
                    <div
                      className={cn(
                        'flex items-center gap-1 rounded-md pr-1 text-[13px] transition-colors',
                        active
                          ? 'bg-muted text-foreground'
                          : 'text-ink-2 hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => void loadSession(s.id)}
                        aria-current={active ? 'true' : undefined}
                        className="focus-visible:ring-ring flex min-w-0 flex-1 flex-col rounded-md px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
                      >
                        <span className={cn('truncate', active && 'font-medium')}>
                          {s.title || 'Untitled chat'}
                        </span>
                        <span
                          className="text-muted-foreground text-[11px] leading-4"
                          suppressHydrationWarning
                        >
                          {formatRelative(s.updatedAt)}
                        </span>
                      </button>
                      {/* Shown on hover, and also whenever it has keyboard
                          focus or the pointer is a finger (there is no hover
                          on touch), so it is never an invisible control. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteSession(s.id);
                        }}
                        className={cn(
                          'text-muted-foreground hover:text-destructive hover:bg-card focus-visible:ring-ring grid size-7 shrink-0 place-items-center rounded-md transition',
                          'pointer-coarse:opacity-100 opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 group-hover:opacity-100',
                          touchTargetClass,
                        )}
                        aria-label="Delete chat"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Conversation column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
          {/* Below md the rail is hidden, so New chat lives here instead. */}
          {turns.length > 0 ? (
            <div
              data-slot="chat-phone-bar"
              className="border-border flex justify-end border-b px-3 py-2 md:hidden"
            >
              {newChatButton}
            </div>
          ) : null}
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5"
            aria-live="polite"
          >
            {turns.length === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                icon={Sparkles}
                title="Ask your inventory anything"
                description="Streamed responses, grounded by tool calls into your real data — no hallucinated quantities. Can adjust stock when you confirm."
                className="mx-auto max-w-lg py-10"
                action={pickSuggestions(referrerPath).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    disabled={busy}
                    className={cn(
                      filterChipClass({ size: 'md' }),
                      'h-auto min-h-[30px] max-w-full whitespace-normal py-1 text-left disabled:opacity-50',
                    )}
                  >
                    {s}
                  </button>
                ))}
              />
            ) : (
              <ul className="space-y-4">
                {turns.map((t, i) => (
                  <li
                    key={i}
                    className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}
                  >
                    <div
                      data-role={t.role}
                      className={cn(
                        'max-w-[85%] rounded-[10px] px-3.5 py-2.5 text-[13.5px] leading-[1.6]',
                        t.role === 'user'
                          ? 'bg-primary text-primary-foreground rounded-br-[4px]'
                          : 'border-border bg-sunk text-foreground rounded-bl-[4px] border',
                      )}
                    >
                      {t.role === 'assistant' && busy && i === turns.length - 1 && !t.content ? (
                        <div className="text-muted-foreground inline-flex items-center gap-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          thinking…
                        </div>
                      ) : (
                        // Plain-text render with whitespace preserved.
                        // NOTE: markdown is NOT parsed here — links the AI
                        // emits (e.g. "[Download CSV](https://…)") show up
                        // as their raw text. This is intentional for v1:
                        // skipping markdown sidesteps XSS surface, and the
                        // CSV-download URLs are long-lived enough for users
                        // to copy-paste. If you ever turn this on, sanitize
                        // first (DOMPurify / react-markdown with a strict
                        // schema) and watch out for tool output that may
                        // contain user-supplied free text.
                        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {t.content}
                        </div>
                      )}
                      {t.toolCalls && t.toolCalls.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                          {t.toolCalls.map((tc, j) => (
                            <span
                              key={j}
                              data-ok={tc.ok ? 'true' : 'false'}
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-px font-mono',
                                tc.ok
                                  ? 'bg-success-wash text-success'
                                  : 'bg-destructive-wash text-destructive',
                              )}
                            >
                              <Wrench className="h-2.5 w-2.5" />
                              {tc.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Inline Confirm button — when the assistant's LAST
                          turn ends with "Confirm?" we surface a single
                          action button so the user doesn't have to type
                          "yes". The detection is purposely conservative:
                          only the last message, not busy, and only when
                          text matches the canned phrasing the system
                          prompt enforces. False positives are harmless
                          (it just sends "yes, confirm" as a normal turn). */}
                      {t.role === 'assistant' &&
                        i === turns.length - 1 &&
                        !busy &&
                        /confirm\?\s*$/i.test(t.content) && (
                          <div className="mt-2.5 flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void send('yes, confirm')}
                            >
                              Confirm
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void send('cancel')}
                            >
                              Cancel
                            </Button>
                          </div>
                        )}
                      {/* Quick-jump action link — when the tool the AI
                          called has a natural dashboard counterpart,
                          show a "Open in dashboard" link under the
                          bubble. Suppresses while the turn is in flight
                          and on confirm-prompt turns (the Confirm/Cancel
                          actions above take priority). */}
                      {(() => {
                        if (t.role !== 'assistant') return null;
                        if (busy && i === turns.length - 1) return null;
                        if (/confirm\?\s*$/i.test(t.content)) return null;
                        const link = jumpLinkFor(t.toolCalls);
                        if (!link) return null;
                        return (
                          <div className="mt-2">
                            <a
                              href={link.href}
                              className={cn(
                                'text-accent hover:text-foreground inline-flex items-center gap-1 text-[12.5px] font-medium underline-offset-2 transition-colors hover:underline',
                                touchTargetClass,
                              )}
                            >
                              {link.label} →
                            </a>
                          </div>
                        );
                      })()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            onDragEnter={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault();
                setDragOver(true);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault();
                setDragOver(true);
              }
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) void uploadFile(f);
            }}
            className={cn(
              'border-border relative flex items-end gap-2 border-t p-2.5 transition-colors',
              dragOver && 'bg-muted',
            )}
          >
            {dragOver && (
              <div className="bg-muted text-foreground border-line-strong pointer-events-none absolute inset-1.5 flex items-center justify-center rounded-md border border-dashed px-3 text-center text-[12.5px] font-medium">
                Drop a PDF, Word, Excel, image, or CSV to extract ISBNs
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp,.heic,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,image/png,image/jpeg,image/webp,image/heic"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy || uploading}
              onClick={() => fileInputRef.current?.click()}
              className="text-muted-foreground shrink-0"
              aria-label="Attach a file with ISBNs"
              title="Attach a PDF, Word, Excel, image, or CSV — the assistant will pull ISBNs out of it."
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </Button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={
                uploading ? 'Reading file…' : 'Ask about your stock, suppliers, or recent activity…'
              }
              rows={1}
              className="placeholder:text-muted-foreground focus-visible:ring-ring max-h-32 min-h-8 flex-1 resize-none rounded-md bg-transparent px-2 py-1.5 text-[13.5px] leading-5 outline-none focus-visible:ring-2 disabled:opacity-60 max-sm:min-h-[60px] max-sm:text-base"
              disabled={busy || uploading}
              aria-label="Ask the inventory assistant"
            />
            <Button
              type="submit"
              variant="gradient"
              size="icon"
              aria-label="Send message"
              disabled={busy || input.trim().length === 0}
              className="shrink-0"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
          </form>
        </div>
        <p className="text-muted-foreground mt-1.5 px-1 text-[11.5px] leading-[17px]">
          ⌘ Enter or Enter to send · Shift+Enter for newline · Drop or attach a PDF / Word / Excel /
          image to bulk-import books · Chats auto-save 30 days.
        </p>
      </div>
    </div>
  );
}
