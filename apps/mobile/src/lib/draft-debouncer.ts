/**
 * Per-key debounced saves that are FLUSHED, never dropped, when the screen
 * that owns them goes away.
 *
 * THE DEFECT. The cycle-count screen saved each typed count 300 ms after the
 * last keystroke (updateLocalLine: the local write and the outbox row). Its
 * unmount cleanup CLEARED the pending timers, so a count typed within 300 ms
 * of leaving the screen (type the last shelf, tap Back) was never saved and
 * never queued: silently lost.
 *
 * `flushAll` saves every pending value at once instead. The value saved is
 * always the LATEST typed for that key, and a key is saved at most once per
 * burst: a flush cancels the timer it replaces, so nothing is saved twice.
 *
 * `dropAll` forgets every pending value unsaved. The count screen uses it only
 * when it is cleared for another account or workspace: a number typed for one
 * is never saved for the other (count-access-refresh.ts countLoadDraftAction).
 */
export interface DraftDebouncer {
  /** Remember `value` for `key` and save it once typing pauses. */
  schedule(key: string, value: string): void;
  /** Save every pending value now (the screen is going away). */
  flushAll(): void;
  /** Forget every pending value, unsaved (the screen now shows another account or workspace). */
  dropAll(): void;
}

export function createDraftDebouncer(
  delayMs: number,
  persist: (key: string, value: string) => void,
): DraftDebouncer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, string>();

  const fire = (key: string) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    if (!pending.has(key)) return;
    const value = pending.get(key) as string;
    pending.delete(key);
    persist(key, value);
  };

  return {
    schedule(key, value) {
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      pending.set(key, value);
      timers.set(
        key,
        setTimeout(() => fire(key), delayMs),
      );
    },
    flushAll() {
      for (const key of [...pending.keys()]) fire(key);
    },
    dropAll() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
    },
  };
}
