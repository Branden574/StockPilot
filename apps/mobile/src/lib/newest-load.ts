import { createSequenceGuard, type SequenceGuard } from './debounced-list-load';

/**
 * The loads of one screen whose reads can overlap (a focus load, a pull to
 * refresh, an action's reload, a load a change of the permissions started),
 * of which only the newest one started may change the screen: the sequence
 * guard the returns workbench uses, plus a way to wait for what the screen
 * then shows.
 *
 * A load takes its number with next() before its first await, or takes none
 * when it reads nothing (the order screen offline), and checks isCurrent()
 * after every read that is followed by a change to the screen.
 *
 * run() starts a load and resolves once the newest load started so far has
 * ended. When a newer load started while its own ran, its own stopped at a
 * check and showed nothing, so it waits for the newer one too, and for any
 * started after that. A caller that clears its busy key, or decides from the
 * order on screen, after its reload (the order screen's runAction and the
 * reason dialogs after a refusal) then does so with the newest order on
 * screen, never the one from before the action (review of the S2 follow-up,
 * F2). A load that throws counts as ended; its error reaches its own caller
 * only, after the wait.
 *
 * Every load of a screen goes through run(), the focus load included: a load
 * started any other way is not waited for.
 *
 * keep() and reload() are for the reloads that run after an await (an
 * action's server call, a sheet's save, Complete picking). A handler holds
 * the `load` of the render it was made in, which may read the screen with
 * permissions, a role or a connection that have since changed: a per-user
 * grant of orders:approve that landed during Complete picking left the order
 * read without the viewer's warehouses, and their own warehouse's controls
 * hidden until a refresh (review of the S2 follow-up, F1). The screen keeps
 * each render's `load` here (a layout effect), and reload() runs the one kept
 * last, through run(). (Kept here rather than in a ref: a handler that reads
 * a ref cannot be handed to a function called during render, as the order
 * screen's action buttons are, under the React Compiler's rules.)
 */
export interface NewestLoads extends SequenceGuard {
  run(start: () => Promise<void>): Promise<void>;
  /** Keeps `start` as the load reload() runs: the newest render's. */
  keep(start: () => Promise<void>): void;
  /** run() with the load kept last; with none kept, waits for the newest load. */
  reload(): Promise<void>;
}

export function createNewestLoads(): NewestLoads {
  const guard = createSequenceGuard();
  /** The newest number taken. */
  let newest = 0;
  /** The end of each numbered load still running, whether it resolved or threw. */
  const running = new Map<number, Promise<void>>();
  /** The load reload() runs. */
  let kept: (() => Promise<void>) | null = null;

  /** Resolves once the newest load has ended, following any newer one started meanwhile. */
  async function newestEnded(): Promise<void> {
    for (;;) {
      const token = newest;
      await running.get(token);
      if (token === newest) return;
    }
  }

  async function run(start: () => Promise<void>): Promise<void> {
    const before = newest;
    // The load takes its number, if it takes one, before its first await.
    const call = start();
    if (newest !== before) {
      const token = newest;
      const ended: Promise<void> = call
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          if (running.get(token) === ended) running.delete(token);
        });
      running.set(token, ended);
    }
    try {
      await call;
    } finally {
      await newestEnded();
    }
  }

  return {
    next() {
      newest = guard.next();
      return newest;
    },
    isCurrent(token: number) {
      return guard.isCurrent(token);
    },
    run,
    keep(start) {
      kept = start;
    },
    reload() {
      const start = kept;
      return run(start ?? (async () => undefined));
    },
  };
}
