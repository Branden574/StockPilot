/**
 * Debounce + stale-response guard for list screens whose load is driven by a
 * search box the user types into (maintenance.tsx's `q`/`scope`).
 *
 * Two independent jobs, each already used INLINE elsewhere in this app —
 * this module gives both a name so they can be unit-tested once instead of
 * hand-verified on every screen that needs them:
 *
 *   - the debounce is the same 250ms `setTimeout`/`clearTimeout` idiom
 *     inventory.tsx and books.tsx already use around their own search
 *     effects ("one 250ms debounce over the whole effect");
 *   - the sequence guard is the same `seqRef` idiom staging.tsx,
 *     item-history-sheet.tsx and add-order-items-sheet.tsx already use to
 *     stop a slow, older response from overwriting a newer one's rows.
 *
 * Pulled out to src/lib rather than left inline because app/ screens import
 * native modules (expo-router, react-native) at load and this project's
 * vitest config excludes app/ entirely (see vitest.config.ts) — extracting
 * the logic here is what makes a REAL behavioral test possible, rather than
 * another source-pin that can only check the text is present.
 */

export interface DebouncedScheduler {
  /** Schedules `fn` to run after the configured delay, cancelling whatever
   *  was previously scheduled. Call on every dependency change (a keystroke,
   *  a scope toggle) — only the LAST call within the delay window ever
   *  actually runs `fn`. */
  schedule(fn: () => void): void;
  /** Cancels a pending call, if any, without scheduling a new one. Call from
   *  a useEffect cleanup so an unmount never fires a delayed load. */
  cancel(): void;
}

/** Creates a debouncer that waits `delayMs` of silence before running the
 *  most recently scheduled function. */
export function createDebouncedScheduler(delayMs: number): DebouncedScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(fn: () => void) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export interface SequenceGuard {
  /** Call at the START of a load, before the request goes out. Returns the
   *  token this call now owns. */
  next(): number;
  /** True when `token` is still the most recently started call. False means
   *  a newer call has since begun and this response is stale — the caller
   *  must not let it overwrite state, whether it resolves or rejects. */
  isCurrent(token: number): boolean;
}

/** Creates a monotonic sequence guard: each `next()` invalidates every token
 *  handed out before it, so an in-flight response for an earlier call can be
 *  detected as stale once a later call has started — regardless of which
 *  response actually lands first over the network. */
export function createSequenceGuard(): SequenceGuard {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(token: number) {
      return token === current;
    },
  };
}
