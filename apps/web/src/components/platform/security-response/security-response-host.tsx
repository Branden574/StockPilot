'use client';

import dynamic from 'next/dynamic';
import * as React from 'react';

import type { SecurityResponseCardId } from '@stockpilot/core';

/**
 * THE HOW-TO-RESPOND PANEL'S HOST: one per page (the attack map's island, the
 * Security page's events list). It holds which card is open and for which
 * entry, and renders the panel. The panel, and with it every card's text,
 * is loaded only when a card is first asked for (next/dynamic, ssr: false):
 * no route carries the cards in its first load
 * (security-response-bundle.guard.test.ts). Nothing is fetched: the cards
 * ship with the panel's code.
 *
 * The panel is a dialog over the right side of the page, not a route. On
 * close, focus goes back to the control that opened it, when that control is
 * still on the page; else to the heading of the list it was in.
 */

/** What the entry the card was opened from shows already, and nothing else. */
export interface SecurityResponseContext {
  /** The kind's name, when the place it was opened from shows one. */
  kind: string | null;
  place: string | null;
  /** The time as the entry shows it, in the viewer's zone ("13:58 PST"). */
  time: string | null;
  /** The same instant, exactly, in UTC ("23 Nov 2026, 21:58 UTC"): the title, and for screen readers. */
  timeUtc?: string | null;
  /** The organization's name (or its id, or "No organization"), where the list shows it. */
  organization: string | null;
}

export interface SecurityResponseRequest {
  cardId: SecurityResponseCardId;
  /** What the entry was, in its own words: the control's name ends with it. */
  what: string;
  context: SecurityResponseContext;
  /**
   * The entry's organization, when it names exactly one: the link on its name
   * under "Opened from", and a route's `<organization id>` filled in.
   */
  organizationId: string | null;
  /**
   * How many organizations the entry was recorded in, when the list knows
   * (the attack map's feeds). More than one: no id, and the panel says so.
   */
  organizations?: number;
}

export interface SecurityResponsePanelProps {
  request: SecurityResponseRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control to give focus back to on close. */
  returnFocusTo: React.RefObject<HTMLElement | null>;
  /** Where focus goes instead when that control has left the page meanwhile (focusFallbackOf). */
  fallbackFocusTo?: React.RefObject<HTMLElement | null>;
}

/**
 * Where focus goes on close when the control that opened the panel has left
 * the page meanwhile (a poll moved its entry out of the list; review S1): the
 * heading of the list it was in (a section named by its heading), else the
 * nearest named section or region. Found when the panel opens, while the
 * control is still on the page.
 */
export function focusFallbackOf(trigger: HTMLElement | null): HTMLElement | null {
  const near =
    trigger?.parentElement?.closest<HTMLElement>(
      'section[aria-labelledby], section[aria-label], [role="region"][aria-label]',
    ) ?? null;
  const headingId = near?.getAttribute('aria-labelledby');
  return (headingId ? near?.ownerDocument.getElementById(headingId) : null) ?? near;
}

interface Host {
  open: (request: SecurityResponseRequest, trigger: HTMLElement | null) => void;
  /** Start loading the panel's code, so the first press opens it at once. */
  preload: () => void;
}

const HostContext = React.createContext<Host | null>(null);

/** The host of the nearest panel, or null outside one (the control then shows nothing). */
export function useSecurityResponseHost(): Host | null {
  return React.useContext(HostContext);
}

const loadPanel = () => import('./security-response-panel');

const SecurityResponsePanel = dynamic<SecurityResponsePanelProps>(
  () => loadPanel().then((m) => m.SecurityResponsePanel),
  { ssr: false, loading: () => null },
);

export function SecurityResponseHost({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = React.useState<{ request: SecurityResponseRequest; n: number } | null>(
    null,
  );
  const [open, setOpen] = React.useState(false);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const fallbackFocusTo = React.useRef<HTMLElement | null>(null);
  const host = React.useMemo<Host>(
    () => ({
      open(request, trigger) {
        returnFocusTo.current = trigger;
        fallbackFocusTo.current = focusFallbackOf(trigger);
        // A new mount for each opening: the panel starts at the card asked for.
        setShown((was) => ({ request, n: (was?.n ?? 0) + 1 }));
        setOpen(true);
      },
      preload() {
        void loadPanel().catch(() => undefined);
      },
    }),
    [],
  );
  return (
    <HostContext.Provider value={host}>
      {children}
      {shown ? (
        <SecurityResponsePanel
          key={shown.n}
          request={shown.request}
          open={open}
          onOpenChange={setOpen}
          returnFocusTo={returnFocusTo}
          fallbackFocusTo={fallbackFocusTo}
        />
      ) : null}
    </HostContext.Provider>
  );
}
