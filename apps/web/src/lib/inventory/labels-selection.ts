// The handoff between the Items bulk bar's "Print labels" and the labels page.
//
// WHY NOT A QUERY STRING: the bar used to link to
// /dashboard/inventory/labels?items=<every selected id>. Each id costs 37
// characters, so 443 selected items made a 16,437-byte request line, and Node
// refused it with 431 before the app ran (lab run, 2026-09-23). The bar has no
// selection cap, so no URL length is safe for it.
//
// So the ids stay in the browser: the bar writes them to sessionStorage under
// a fresh random key and navigates to ?selection=<key> (a 36-character uuid,
// whatever the selection size). The labels page reads them back in the same
// tab and sends them to the server in a POST body (a Server Action), where
// the same read the page always used decides which items the caller may see.
// Same pattern, and the same reasons, as the Start-an-order handoff
// (lib/orders/start-order-prefill.ts).
//
// The entry is NOT removed on read: reloading the labels page (common while
// fiddling with a printer) must still work. Old entries are pruned on write.

/** The most items one label sheet prints; the Server Action refuses more. */
export const LABELS_MAX_ITEMS = 500;

/** Up to this many ids still travel as ?items= when storage is unavailable:
 *  100 ids make a 3,733-character URL, a quarter of Node's 16 KB header
 *  limit, leaving the rest for cookies. */
export const LABELS_URL_FALLBACK_MAX = 100;

/** sessionStorage key prefix. Versioned so a shape change cannot feed a stale blob. */
export const LABELS_SELECTION_PREFIX = 'sp:labels-selection:v1:';

/** Selections kept per tab; older ones are pruned when a new one is written. */
const KEEP_SELECTIONS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Well-formed ids only, deduped, in first-seen order. */
export function cleanLabelIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!isUuid(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function labelsSelectionHref(key: string): string {
  return `/dashboard/inventory/labels?selection=${encodeURIComponent(key)}`;
}

export function labelsItemsHref(ids: readonly string[]): string {
  return `/dashboard/inventory/labels?items=${ids.join(',')}`;
}

type Stored = { ids: string[]; savedAt: number };

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Store a selection and return its key, or null when storage is unavailable
 * (blocked site data, a sandboxed frame) or full. Client-only.
 */
export function writeLabelsSelection(ids: readonly string[]): string | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const key = crypto.randomUUID();
    const entry: Stored = { ids: cleanLabelIds(ids), savedAt: Date.now() };
    pruneOldSelections(storage);
    storage.setItem(LABELS_SELECTION_PREFIX + key, JSON.stringify(entry));
    return key;
  } catch {
    return null;
  }
}

/** Keep the newest KEEP_SELECTIONS - 1 entries, making room for one more. */
function pruneOldSelections(storage: Storage): void {
  const entries: Array<{ key: string; savedAt: number }> = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(LABELS_SELECTION_PREFIX)) continue;
    let savedAt = 0;
    try {
      savedAt = Number((JSON.parse(storage.getItem(key) ?? '{}') as Partial<Stored>).savedAt) || 0;
    } catch {
      savedAt = 0;
    }
    entries.push({ key, savedAt });
  }
  entries.sort((a, b) => b.savedAt - a.savedAt);
  for (const { key } of entries.slice(KEEP_SELECTIONS - 1)) storage.removeItem(key);
}

/**
 * The ids stored under `key`, or null when there is no such selection in this
 * tab (another tab, a cleared session, a malformed key or blob). Never throws.
 */
export function readLabelsSelection(key: string): string[] | null {
  if (!isUuid(key)) return null;
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(LABELS_SELECTION_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (!parsed || !Array.isArray(parsed.ids)) return null;
    return cleanLabelIds(parsed.ids);
  } catch {
    return null;
  }
}
