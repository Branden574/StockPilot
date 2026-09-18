import * as React from 'react';

/**
 * A place for a form to say "I am holding work that a reload would lose", so the
 * ONE global action that reloads the page ("Refresh to update") can ask before
 * it does.
 *
 * Dirtiness in this app is local to each form and nothing shared knew about it,
 * so a refresh prompt could only reload blind. This is the smallest honest fix:
 * a module-level registry that forms opt into. It is deliberately NOT a draft
 * store. It saves nothing and restores nothing; it only lets a reload be
 * refused.
 *
 * THE LIMIT, which the UI must not paper over: only forms that REGISTER are
 * protected. The refresh copy may say "unsaved changes in: New item"; it may
 * never say "nothing will be lost".
 *
 * `isDirty` is called at the moment of the click, not on every keystroke, so a
 * form can compute it as expensively as it likes. A source that throws is
 * treated as DIRTY: a guard that fails open is not a guard.
 */

export interface UnsavedSource {
  /** Stable per mounted form, e.g. 'item-form'. */
  id: string;
  /** How the person knows this work, e.g. 'New item' or 'Receiving PO-1042'. */
  label: string;
  isDirty: () => boolean;
}

const sources = new Map<string, UnsavedSource>();

export function registerUnsavedSource(source: UnsavedSource): () => void {
  sources.set(source.id, source);
  return () => {
    // Only remove OUR registration: a remount may already have replaced it.
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
}

/** The sources that are dirty RIGHT NOW. */
export function getUnsavedSources(): Array<{ id: string; label: string }> {
  const dirty: Array<{ id: string; label: string }> = [];
  for (const s of sources.values()) {
    let is = true;
    try {
      is = s.isDirty();
    } catch {
      is = true;
    }
    if (is) dirty.push({ id: s.id, label: s.label });
  }
  return dirty;
}

/** Test seam: module state would otherwise leak between tests. */
export function resetUnsavedSourcesForTests(): void {
  sources.clear();
}

/**
 * Register a form for as long as it is mounted. `isDirty` may be a boolean the
 * form already tracks or a function; either way the LATEST value is read at
 * click time through a ref, so registering once is enough.
 */
export function useUnsavedWork(
  id: string,
  label: string,
  isDirty: boolean | (() => boolean),
): void {
  const latest = React.useRef(isDirty);
  React.useEffect(() => {
    latest.current = isDirty;
  });
  React.useEffect(
    () =>
      registerUnsavedSource({
        id,
        label,
        isDirty: () => (typeof latest.current === 'function' ? latest.current() : latest.current),
      }),
    [id, label],
  );
}
