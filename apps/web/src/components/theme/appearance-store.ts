import type { AppearanceStyle, AppearanceSyncStatus, ThemeSetting } from '@stockpilot/core';

/**
 * The appearance facts that change while a page is open, kept OUTSIDE React's
 * context (L4 triage BF1).
 *
 * WHY NOT CONTEXT. The appearance provider sits in the root layout, above
 * every page. A page that streams (a Suspense boundary whose content arrives
 * after the shell) is adopted by React when that content arrives, unless a
 * context value above it changed in the meantime: React then marks every
 * boundary that is not adopted yet, gives it one try at a raised priority,
 * and, since its content is not there, renders it in the browser and throws
 * the server's HTML for it away (react-dom-client: propagateContextChanges,
 * `18 === fiber.tag`; updateDehydratedSuspenseComponent ->
 * retrySuspenseComponentWithoutHydrating). The appearance layer learns several
 * things while a page loads (the device records at mount, the attribute it
 * wrote, the Theme, the person the shell names, the account's answer), and
 * each of them used to be a new context value.
 *
 * So the context holds one object that never changes (the actions and these
 * stores), and what changes lives here. Only a component that reads a store
 * (useSyncExternalStore) renders again when it changes; nothing is propagated
 * through the tree, so a boundary that is still streaming is left alone.
 *
 * THE SERVER SNAPSHOT is the value the store was created with: what the
 * server rendered, and what React hands a reader while it adopts server HTML,
 * however much the store has learned since. So a reader inside late content
 * hydrates against the HTML the server made and renders the current facts
 * right after.
 */

export interface FactStore<T extends object> {
  /** Calls the listener after every change. Returns the way to stop. */
  subscribe: (listener: () => void) => () => void;
  /** The current facts: the same object until one of them changes. */
  getSnapshot: () => T;
  /** The facts the store was created with (the server render, the first client render). */
  getServerSnapshot: () => T;
  /**
   * Take new values for some facts. Listeners are told once, and only when a
   * value really differs (Object.is); otherwise the snapshot keeps its
   * identity and nobody renders.
   */
  set: (patch: Partial<T>) => void;
}

export function createFactStore<T extends object>(initial: T): FactStore<T> {
  const server = Object.freeze({ ...initial });
  let snapshot: T = server;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => server,
    set(patch) {
      let changed = false;
      for (const key of Object.keys(patch) as (keyof T)[]) {
        if (!Object.is(snapshot[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      snapshot = Object.freeze({ ...snapshot, ...patch });
      // A copy: a listener may stop listening while it is told.
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** What the selectors read (the changing half of AppearanceContextValue). */
export interface AppearanceFacts {
  /** False until the device records were read after mount (server render and first paint). */
  hydrated: boolean;
  /** The Design the person chose (null: never chose, the rollout's default shows). */
  style: AppearanceStyle | null;
  /** The Theme in use (next-themes' setting), or undefined before hydrate. */
  theme: ThemeSetting | undefined;
  /** The Design on screen: the choice through the rollout and the crash fallback. */
  shownStyle: AppearanceStyle;
  /** <html> carries data-appearance="liquid-glass", as the provider last wrote it after hydrate. */
  glassApplied: boolean;
  /** Account sync, for the selector's status line; null until the session is known. */
  status: AppearanceSyncStatus | null;
}

/** What only the provider's own pieces read (the variant guard, the intro notice). */
export interface AppearanceInnerFacts {
  /** This tab shows classic after a glass crash (plan 5.6). */
  fallback: boolean;
  /** The signed-in person whose account row was read, or null. */
  accountRead: string | null;
}

const NOTHING = () => () => {};
const NO_FACTS = () => null;

/** For a reader with no provider above: never changes, always null. */
export const NO_FACT_STORE = {
  subscribe: NOTHING,
  getSnapshot: NO_FACTS,
  getServerSnapshot: NO_FACTS,
} as const;
