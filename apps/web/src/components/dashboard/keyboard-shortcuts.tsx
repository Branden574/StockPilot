'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Shortcuts table — kept in one place so the listener and the overlay stay in
// sync. `keys` is what we render inside <kbd> chips; for two-key sequences we
// use a `prefix` + `key` pair so the state machine below can match against
// the canonical case-insensitive value.
type Section = 'Navigation' | 'New things' | 'Help' | 'Search';

interface ShortcutRow {
  /** Visual key chips (in order). */
  keys: string[];
  description: string;
  section: Section;
}

interface NavShortcut {
  prefix: 'g' | 'n';
  key: string; // canonical lowercase key — matched against e.key.toLowerCase()
  href: string;
}

const NAV_SHORTCUTS: NavShortcut[] = [
  { prefix: 'g', key: 'i', href: '/dashboard/inventory' },
  { prefix: 'g', key: 'b', href: '/dashboard/books' },
  { prefix: 'g', key: 'p', href: '/dashboard/purchase-orders' },
  { prefix: 'g', key: 's', href: '/dashboard/shipments' },
  { prefix: 'g', key: 'c', href: '/dashboard/cycle-counts' },
  { prefix: 'g', key: 'o', href: '/dashboard/orders' },
  { prefix: 'g', key: 'r', href: '/dashboard/reports' },
  { prefix: 'g', key: 't', href: '/dashboard/team' },
  { prefix: 'g', key: ',', href: '/dashboard/settings' },
  { prefix: 'n', key: 'i', href: '/dashboard/inventory/new' },
  { prefix: 'n', key: 'p', href: '/dashboard/purchase-orders/new' },
  { prefix: 'n', key: 's', href: '/dashboard/shipments/new' },
  { prefix: 'n', key: 'c', href: '/dashboard/cycle-counts/new' },
];

// Rendered in the overlay, grouped by `section`. Order matters.
const SHORTCUT_ROWS: ShortcutRow[] = [
  { keys: ['g', 'i'], description: 'Inventory items', section: 'Navigation' },
  { keys: ['g', 'b'], description: 'Books', section: 'Navigation' },
  { keys: ['g', 'p'], description: 'Purchase orders', section: 'Navigation' },
  { keys: ['g', 's'], description: 'Shipments', section: 'Navigation' },
  { keys: ['g', 'c'], description: 'Cycle counts', section: 'Navigation' },
  { keys: ['g', 'o'], description: 'Orders', section: 'Navigation' },
  { keys: ['g', 'r'], description: 'Reports', section: 'Navigation' },
  { keys: ['g', 't'], description: 'Team', section: 'Navigation' },
  { keys: ['g', ','], description: 'Settings', section: 'Navigation' },
  { keys: ['n', 'i'], description: 'New item', section: 'New things' },
  { keys: ['n', 'p'], description: 'New purchase order', section: 'New things' },
  { keys: ['n', 's'], description: 'New shipment', section: 'New things' },
  { keys: ['n', 'c'], description: 'New cycle count', section: 'New things' },
  { keys: ['?'], description: 'Open this keyboard-shortcuts overlay', section: 'Help' },
  { keys: ['Esc'], description: 'Close the overlay', section: 'Help' },
  { keys: ['⌘', 'K'], description: 'Open command palette (Ctrl+K on Windows)', section: 'Search' },
];

const SECTION_ORDER: Section[] = ['Navigation', 'New things', 'Search', 'Help'];

const KBD = cn(
  'border-border bg-card rounded border px-1.5 py-px font-mono text-[10.5px] text-foreground',
);

/**
 * Two-key sequence reset window. Long enough that a deliberate human chord
 * still lands ("press g, then press i") but short enough that a stray
 * earlier `g` doesn't surprise the user a second later.
 */
const PREFIX_RESET_MS = 1500;

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function KeyboardShortcutsProvider() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  // We use a ref for the prefix so the keydown handler — which is registered
  // once on mount — always reads the latest value without re-binding the
  // listener on every keystroke (which would itself reset the prefix).
  const prefixRef = React.useRef<null | 'g' | 'n'>(null);
  const prefixTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPrefix = React.useCallback(() => {
    prefixRef.current = null;
    if (prefixTimerRef.current) {
      clearTimeout(prefixTimerRef.current);
      prefixTimerRef.current = null;
    }
  }, []);

  const armPrefix = React.useCallback(
    (p: 'g' | 'n') => {
      if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);
      prefixRef.current = p;
      prefixTimerRef.current = setTimeout(() => {
        prefixRef.current = null;
        prefixTimerRef.current = null;
      }, PREFIX_RESET_MS);
    },
    [],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Never hijack chords with modifiers (⌘K, Ctrl+S, etc.) — those have
      // their own handlers (command palette, browser save, …).
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearPrefix();
        return;
      }

      // If the user is typing into a field, do nothing. Any pending prefix
      // should also be cleared so it doesn't fire after they tab out.
      if (isTypingTarget(document.activeElement)) {
        clearPrefix();
        return;
      }

      // `?` opens the overlay. shift+/ produces '?' on US layouts — check
      // e.key directly, not e.code, per the brief.
      if (e.key === '?') {
        e.preventDefault();
        clearPrefix();
        setOpen(true);
        return;
      }

      // Two-key sequence: prefix already armed → try to complete.
      if (prefixRef.current) {
        const prefix = prefixRef.current;
        const k = e.key.toLowerCase();
        // The comma key is the only non-letter target. e.key for "," is
        // already ",", so lowercase is a no-op there.
        const match = NAV_SHORTCUTS.find((s) => s.prefix === prefix && s.key === k);
        clearPrefix();
        if (match) {
          e.preventDefault();
          router.push(match.href);
        }
        return;
      }

      // Arm a new prefix on `g` or `n`. Pure letter keys only — Shift+G
      // already wouldn't reach here on most layouts (key would be 'G' upper),
      // but be explicit.
      if (e.key === 'g' || e.key === 'n') {
        armPrefix(e.key);
        return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);
    };
  }, [armPrefix, clearPrefix, router]);

  // Group rows for rendering. Empty sections are dropped so the layout
  // doesn't show a "Help" heading with nothing under it.
  const grouped = React.useMemo(() => {
    const map = new Map<Section, ShortcutRow[]>();
    for (const row of SHORTCUT_ROWS) {
      const list = map.get(row.section) ?? [];
      list.push(row);
      map.set(row.section, list);
    }
    return SECTION_ORDER.map((s) => ({ section: s, rows: map.get(s) ?? [] })).filter(
      (g) => g.rows.length > 0,
    );
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[560px]">
        <div className="border-border border-b px-5 py-4">
          <DialogTitle className="text-base font-semibold">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            Press <kbd className={KBD}>?</kbd> anywhere to open this. Sequences like
            <kbd className={cn(KBD, 'mx-1')}>g</kbd>
            then
            <kbd className={cn(KBD, 'mx-1')}>i</kbd>
            jump to a section.
          </DialogDescription>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {grouped.map(({ section, rows }) => (
            <section key={section} className="mb-5 last:mb-0">
              <h3 className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-wider">
                {section}
              </h3>
              <ul className="space-y-1.5">
                {rows.map((row) => (
                  <li
                    key={`${section}-${row.keys.join('+')}-${row.description}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="flex items-center gap-1">
                      {row.keys.map((k, idx) => (
                        <React.Fragment key={`${k}-${idx}`}>
                          {idx > 0 && (
                            <span className="text-muted-foreground text-[10px]">then</span>
                          )}
                          <kbd className={KBD}>{k}</kbd>
                        </React.Fragment>
                      ))}
                    </span>
                    <span className="text-muted-foreground flex-1 text-right text-[13px]">
                      {row.description}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Exposed for tests + the topbar trigger button. We dispatch a synthetic `?`
// keydown so we don't have to plumb a context through the layout — the
// provider's own listener picks it up and opens the overlay. This mirrors the
// trick the topbar already uses to open the command palette.
export function openKeyboardShortcutsOverlay() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
}

// Test-only exports — left non-underscored to keep grep simple. Importing
// these from production code is fine but unintended.
export const __TEST__ = {
  NAV_SHORTCUTS,
  SHORTCUT_ROWS,
  PREFIX_RESET_MS,
};
