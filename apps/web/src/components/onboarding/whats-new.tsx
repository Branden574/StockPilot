'use client';

import { Gift, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { capture } from '@/lib/analytics';
import {
  getUnseenAnnouncementsAction,
  recordAnnouncementsSeenAction,
} from '@/lib/onboarding/actions';

interface Item {
  id: string;
  date: string;
  title: string;
  body: string;
  cta?: { href: string; label: string };
}

/**
 * What's New (owner PRD §5): announces recent releases once per user,
 * as a small centered card with a dot carousel when several are unseen.
 * Mounted in the dashboard layout. Never shown when the URL is starting
 * a tour (?tour=) — one interruption at a time — and it waits a beat so
 * it never races the page's own content.
 */
export function WhatsNew() {
  const [items, setItems] = React.useState<Item[]>([]);
  const [index, setIndex] = React.useState(0);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tour')) return;
    let cancelled = false;
    void getUnseenAnnouncementsAction().then((unseen) => {
      if (cancelled || unseen.length === 0) return;
      setItems(unseen);
      // Small delay: let the page render before we speak up.
      setTimeout(() => {
        if (!cancelled) {
          setOpen(true);
          capture('whats_new_shown', { count: unseen.length, ids: unseen.map((u) => u.id) });
        }
      }, 1200);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = React.useCallback(
    (outcome: 'seen' | 'dismissed') => {
      setOpen(false);
      capture('whats_new_closed', { outcome, ids: items.map((i) => i.id) });
      void recordAnnouncementsSeenAction({ ids: items.map((i) => i.id), outcome });
    },
    [items],
  );

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close('dismissed');
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, items.length - 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items.length, close]);

  if (!open || items.length === 0) return null;
  const item = items[index]!;
  const isLast = index === items.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div
        aria-hidden
        className="animate-in fade-in fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => close('dismissed')}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`What's new: ${item.title}`}
        className="bg-card animate-in fade-in zoom-in-95 relative w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      >
        <button
          type="button"
          aria-label="Dismiss what's new"
          onClick={() => close('dismissed')}
          className="text-muted-foreground hover:text-foreground absolute right-4 top-4"
        >
          <X className="size-4" />
        </button>
        <div className="text-primary flex items-center gap-2 text-xs font-medium">
          <Gift className="size-4" /> What&apos;s new · {item.date}
        </div>
        <h2 className="mt-2 text-lg font-semibold tracking-tight">{item.title}</h2>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{item.body}</p>

        <div className="mt-5 flex items-center gap-2">
          {items.length > 1 && (
            <div className="flex flex-1 items-center gap-1" aria-hidden>
              {items.map((_, i) => (
                <span
                  key={i}
                  className={
                    'h-1.5 rounded-full transition-all ' +
                    (i === index ? 'bg-primary w-4' : 'bg-muted w-1.5')
                  }
                />
              ))}
            </div>
          )}
          {items.length === 1 && <div className="flex-1" />}
          {item.cta && (
            <Button asChild size="sm" variant="outline">
              <Link href={item.cta.href} onClick={() => close('seen')}>
                {item.cta.label}
              </Link>
            </Button>
          )}
          {isLast ? (
            <Button size="sm" onClick={() => close('seen')}>
              Done
            </Button>
          ) : (
            <Button size="sm" onClick={() => setIndex(index + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
