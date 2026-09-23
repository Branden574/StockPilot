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
//
// A NEW TAB. The bar's control is a link, so cmd-click, middle-click and
// "Open in new tab" work as they did when the ids rode in the URL. But
// sessionStorage belongs to one tab, and Chrome no longer copies it into a tab
// opened from a link, so the write also leaves a short-lived copy in
// localStorage (LABELS_HANDOFF_TTL_MS, at most KEEP_SELECTIONS copies). A tab
// that does not find the key in its own sessionStorage takes the copy and
// keeps it in its own sessionStorage, so its reloads work after the copy
// expires. The copy holds item ids only, and the labels page still asks the
// server, which returns only the items the caller may read.

/** The most items one label sheet prints; the Server Action refuses more. */
export const LABELS_MAX_ITEMS = 500;

/** Up to this many ids still travel as ?items= when storage is unavailable:
 *  100 ids make a 3,733-character URL, a quarter of Node's 16 KB header
 *  limit, leaving the rest for cookies. */
export const LABELS_URL_FALLBACK_MAX = 100;

/** Storage key prefix. Versioned so a shape change cannot feed a stale blob. */
export const LABELS_SELECTION_PREFIX = 'sp:labels-selection:v1:';

/** How long the localStorage copy for a new tab is honoured. A tab opened with
 *  cmd-click loads at once; this leaves room for one opened in the background
 *  and looked at a few minutes later. */
export const LABELS_HANDOFF_TTL_MS = 10 * 60 * 1000;

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

function safeStorage(kind: 'session' | 'local'): Storage | null {
  try {
    if (kind === 'session') return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Write one entry; false when the storage is missing, blocked or full. */
function tryWrite(storage: Storage | null, key: string, value: string, prune: () => void): boolean {
  if (!storage) return false;
  try {
    prune();
    storage.setItem(LABELS_SELECTION_PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store a selection and return its key, or null when storage is unavailable
 * (blocked site data, a sandboxed frame) or full. Writes this tab's copy and
 * the short-lived copy a new tab can pick up. Client-only.
 */
export function writeLabelsSelection(ids: readonly string[]): string | null {
  let key: string;
  let value: string;
  try {
    key = crypto.randomUUID();
    const entry: Stored = { ids: cleanLabelIds(ids), savedAt: Date.now() };
    value = JSON.stringify(entry);
  } catch {
    return null;
  }
  const session = safeStorage('session');
  const local = safeStorage('local');
  const inTab = tryWrite(session, key, value, () => pruneOldSelections(session!, 0));
  const forNewTab = tryWrite(local, key, value, () =>
    pruneOldSelections(local!, LABELS_HANDOFF_TTL_MS),
  );
  return inTab || forNewTab ? key : null;
}

/**
 * Keep the newest KEEP_SELECTIONS - 1 entries, making room for one more, and
 * drop entries older than `ttlMs` when it is set.
 */
function pruneOldSelections(storage: Storage, ttlMs: number): void {
  const entries: Array<{ key: string; savedAt: number }> = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(LABELS_SELECTION_PREFIX)) continue;
    entries.push({ key, savedAt: savedAtOf(storage.getItem(key)) });
  }
  entries.sort((a, b) => b.savedAt - a.savedAt);
  const now = Date.now();
  entries.forEach(({ key, savedAt }, i) => {
    if (i >= KEEP_SELECTIONS - 1 || (ttlMs > 0 && now - savedAt > ttlMs)) storage.removeItem(key);
  });
}

function savedAtOf(raw: string | null): number {
  try {
    return Number((JSON.parse(raw ?? '{}') as Partial<Stored>).savedAt) || 0;
  } catch {
    return 0;
  }
}

function parseIds(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (!parsed || !Array.isArray(parsed.ids)) return null;
    return cleanLabelIds(parsed.ids);
  } catch {
    return null;
  }
}

/**
 * The ids stored under `key`, or null when there is no such selection (a tab
 * of another browser, a handoff copy that expired, a cleared session, a
 * malformed key or blob). This tab's own copy first, then the handoff copy
 * for a tab opened from the link, which is then kept in this tab. Never
 * throws.
 */
export function readLabelsSelection(key: string): string[] | null {
  if (!isUuid(key)) return null;
  const session = safeStorage('session');
  try {
    const own = parseIds(session?.getItem(LABELS_SELECTION_PREFIX + key) ?? null);
    if (own) return own;
  } catch {
    // Unreadable here; try the handoff copy.
  }
  const local = safeStorage('local');
  if (!local) return null;
  try {
    const raw = local.getItem(LABELS_SELECTION_PREFIX + key);
    if (!raw) return null;
    if (Date.now() - savedAtOf(raw) > LABELS_HANDOFF_TTL_MS) {
      local.removeItem(LABELS_SELECTION_PREFIX + key);
      return null;
    }
    const ids = parseIds(raw);
    if (!ids) return null;
    // Kept in this tab, so reloading it works after the copy expires.
    if (session) tryWrite(session, key, raw, () => pruneOldSelections(session, 0));
    return ids;
  } catch {
    return null;
  }
}
