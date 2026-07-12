'use client';

import { ArrowDown, ArrowUp, Eye, EyeOff, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { NAV_ICONS } from '@/components/dashboard/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { setNavOverridesAction } from '@/server/actions/nav-settings';

import {
  isSafeNavHref,
  type NavOverrides,
  type NavSectionKey,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Types passed from the server page.
// ---------------------------------------------------------------------------

interface BaseItem {
  href: string;
  label: string;
  iconName: string;
}

interface BaseSection {
  section: NavSectionKey;
  items: BaseItem[];
}

interface NavCustomizerProps {
  /** The resolved base nav (admin role + enabled modules), grouped by section. */
  baseSections: BaseSection[];
  /** Currently-saved overrides (v1) or null. */
  initialOverrides: NavOverrides | null;
}

const SECTION_LABELS: Record<NavSectionKey, string> = {
  overview: 'Overview',
  inventory: 'Inventory',
  workspace: 'Workspace',
  tools: 'Tools',
  admin: 'Admin',
};

const SECTION_OPTIONS: NavSectionKey[] = [
  'overview',
  'inventory',
  'workspace',
  'tools',
  'admin',
];

const ICON_NAMES = Object.keys(NAV_ICONS).sort();
const LABEL_MAX = 60;
const MAX_CUSTOM_LINKS = 50;

// ---------------------------------------------------------------------------
// Local editor state. We keep an ordered, per-section view that mirrors what
// `applyNavOverrides` will produce, then serialize it back into a NavOverrides
// payload on save.
// ---------------------------------------------------------------------------

interface EditableItem {
  href: string;
  /** Resolved default label from the registry. */
  defaultLabel: string;
  /** Current (possibly renamed) label. */
  label: string;
  iconName: string;
  hidden: boolean;
}

type SectionState = Record<NavSectionKey, EditableItem[]>;

interface CustomLink {
  id: string;
  label: string;
  href: string;
  section: NavSectionKey;
  iconName: string;
}

function buildInitialState(
  baseSections: BaseSection[],
  overrides: NavOverrides | null,
): SectionState {
  const hidden = new Set(overrides?.hidden ?? []);
  const labels = overrides?.labels ?? {};
  const order = overrides?.order ?? {};

  const state = {} as SectionState;
  for (const sec of SECTION_OPTIONS) state[sec] = [];

  for (const base of baseSections) {
    const items: EditableItem[] = base.items.map((it) => {
      const override = labels[it.href];
      return {
        href: it.href,
        defaultLabel: it.label,
        label: typeof override === 'string' ? override : it.label,
        iconName: it.iconName,
        hidden: hidden.has(it.href),
      };
    });

    // Apply saved order: hrefs in order[section] first (in that order), rest after.
    const wanted = order[base.section];
    if (Array.isArray(wanted) && wanted.length > 0) {
      const byHref = new Map(items.map((it) => [it.href, it]));
      const seen = new Set<string>();
      const front: EditableItem[] = [];
      for (const href of wanted) {
        const it = byHref.get(href);
        if (it && !seen.has(href)) {
          front.push(it);
          seen.add(href);
        }
      }
      const rest = items.filter((it) => !seen.has(it.href));
      state[base.section] = [...front, ...rest];
    } else {
      state[base.section] = items;
    }
  }

  return state;
}

export function NavCustomizer({ baseSections, initialOverrides }: NavCustomizerProps) {
  const [sections, setSections] = React.useState<SectionState>(() =>
    buildInitialState(baseSections, initialOverrides),
  );
  const [custom, setCustom] = React.useState<CustomLink[]>(
    () => (initialOverrides?.custom ?? []).map((c) => ({ ...c })),
  );
  const [saving, startTransition] = React.useTransition();

  // New-custom-link form state.
  const [newLabel, setNewLabel] = React.useState('');
  const [newHref, setNewHref] = React.useState('');
  const [newSection, setNewSection] = React.useState<NavSectionKey>('tools');
  const [newIcon, setNewIcon] = React.useState<string>(ICON_NAMES[0] ?? 'Boxes');

  // Which sections actually have base items (so we don't render empty groups).
  const presentSections = SECTION_OPTIONS.filter((s) => sections[s].length > 0);

  function toggleHidden(section: NavSectionKey, href: string) {
    setSections((prev) => ({
      ...prev,
      [section]: prev[section].map((it) =>
        it.href === href ? { ...it, hidden: !it.hidden } : it,
      ),
    }));
  }

  function rename(section: NavSectionKey, href: string, label: string) {
    setSections((prev) => ({
      ...prev,
      [section]: prev[section].map((it) => (it.href === href ? { ...it, label } : it)),
    }));
  }

  function move(section: NavSectionKey, index: number, dir: -1 | 1) {
    setSections((prev) => {
      const arr = [...prev[section]];
      const target = index + dir;
      if (target < 0 || target >= arr.length) return prev;
      const a = arr[index];
      const b = arr[target];
      if (!a || !b) return prev;
      arr[index] = b;
      arr[target] = a;
      return { ...prev, [section]: arr };
    });
  }

  function removeCustom(id: string) {
    setCustom((prev) => prev.filter((c) => c.id !== id));
  }

  function addCustom() {
    const label = newLabel.trim();
    const href = newHref.trim();
    if (label.length === 0) {
      toast.error('Enter a label for the link.');
      return;
    }
    if (label.length > LABEL_MAX) {
      toast.error(`Label must be ${LABEL_MAX} characters or fewer.`);
      return;
    }
    if (!isSafeNavHref(href)) {
      toast.error('Enter a valid internal path (starts with /) or an http(s):// URL.');
      return;
    }
    if (custom.length >= MAX_CUSTOM_LINKS) {
      toast.error(`You can add at most ${MAX_CUSTOM_LINKS} custom links.`);
      return;
    }
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setCustom((prev) => [
      ...prev,
      { id, label, href, section: newSection, iconName: newIcon },
    ]);
    setNewLabel('');
    setNewHref('');
  }

  /** Serialize the editor state into a NavOverrides payload (or null if empty). */
  function buildOverrides(): NavOverrides | null {
    const hidden: string[] = [];
    const labels: Record<string, string> = {};
    const order: Partial<Record<NavSectionKey, string[]>> = {};

    for (const sec of SECTION_OPTIONS) {
      const items = sections[sec];
      if (items.length === 0) continue;

      // Record renames + hidden flags.
      for (const it of items) {
        if (it.hidden) hidden.push(it.href);
        const renamed = it.label.trim();
        if (renamed.length > 0 && renamed !== it.defaultLabel) labels[it.href] = renamed;
      }

      // Record order only if it differs from the resolved (base) order. The base
      // order is the order in `baseSections`; compare against current href order.
      const base = baseSections.find((b) => b.section === sec);
      const baseHrefs = base ? base.items.map((i) => i.href) : [];
      const currentHrefs = items.map((i) => i.href);
      const changed =
        currentHrefs.length !== baseHrefs.length ||
        currentHrefs.some((h, i) => h !== baseHrefs[i]);
      if (changed) order[sec] = currentHrefs;
    }

    const customLinks = custom.map((c, i) => ({
      id: c.id,
      label: c.label.trim(),
      href: c.href.trim(),
      section: c.section,
      iconName: c.iconName,
      sortOrder: i,
    }));

    const hasAny =
      hidden.length > 0 ||
      Object.keys(labels).length > 0 ||
      Object.keys(order).length > 0 ||
      customLinks.length > 0;
    if (!hasAny) return null;

    return {
      v: 1,
      ...(hidden.length > 0 ? { hidden } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(Object.keys(order).length > 0 ? { order } : {}),
      ...(customLinks.length > 0 ? { custom: customLinks } : {}),
    };
  }

  function save() {
    const overrides = buildOverrides();
    startTransition(async () => {
      const res = await setNavOverridesAction(overrides);
      if (res.ok) {
        toast.success('Navigation saved.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function reset() {
    startTransition(async () => {
      const res = await setNavOverridesAction(null);
      if (res.ok) {
        setSections(buildInitialState(baseSections, null));
        setCustom([]);
        toast.success('Navigation reset to default.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <div className="space-y-8">
      {presentSections.map((sec) => {
        const items = sections[sec];
        const customInSection = custom.filter((c) => c.section === sec);
        return (
          <section key={sec} className="space-y-3">
            <h3 className="text-sm font-semibold">{SECTION_LABELS[sec]}</h3>
            <div className="divide-border divide-y rounded-md border">
              {items.map((it, idx) => {
                const Icon = NAV_ICONS[it.iconName];
                return (
                  <div
                    key={it.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5',
                      it.hidden && 'opacity-50',
                    )}
                  >
                    {Icon && <Icon className="text-muted-foreground h-4 w-4 shrink-0" />}
                    <Input
                      value={it.label}
                      maxLength={LABEL_MAX}
                      onChange={(e) => rename(sec, it.href, e.target.value)}
                      aria-label={`Rename ${it.defaultLabel}`}
                      className="h-8 flex-1"
                      disabled={it.hidden}
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Move ${it.defaultLabel} up`}
                        disabled={idx === 0}
                        onClick={() => move(sec, idx, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Move ${it.defaultLabel} down`}
                        disabled={idx === items.length - 1}
                        onClick={() => move(sec, idx, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={it.hidden ? `Show ${it.defaultLabel}` : `Hide ${it.defaultLabel}`}
                        aria-pressed={it.hidden}
                        onClick={() => toggleHidden(sec, it.href)}
                      >
                        {it.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                );
              })}
              {customInSection.map((c) => {
                const Icon = NAV_ICONS[c.iconName];
                return (
                  <div key={c.id} className="bg-muted/40 flex items-center gap-3 px-3 py-2.5">
                    {Icon && <Icon className="text-muted-foreground h-4 w-4 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.label}</div>
                      <div className="text-muted-foreground truncate text-xs">{c.href}</div>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-[10px] uppercase tracking-wide">
                      Custom
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      aria-label={`Remove ${c.label}`}
                      onClick={() => removeCustom(c.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* Add custom link */}
      <section className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Add custom link</h3>
        <p className="text-muted-foreground text-xs">
          Link to an internal page (path starting with <code>/</code>) or an external{' '}
          <code>https://</code> URL.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="nav-new-label">
              Label
            </label>
            <Input
              id="nav-new-label"
              value={newLabel}
              maxLength={LABEL_MAX}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Help center"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="nav-new-href">
              URL
            </label>
            <Input
              id="nav-new-href"
              value={newHref}
              onChange={(e) => setNewHref(e.target.value)}
              placeholder="/dashboard/reports or https://…"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="nav-new-section">
              Section
            </label>
            <select
              id="nav-new-section"
              value={newSection}
              onChange={(e) => setNewSection(e.target.value as NavSectionKey)}
              className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm"
            >
              {SECTION_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {SECTION_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="nav-new-icon">
              Icon
            </label>
            <select
              id="nav-new-icon"
              value={newIcon}
              onChange={(e) => setNewIcon(e.target.value)}
              className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm"
            >
              {ICON_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addCustom}>
          Add link
        </Button>
      </section>

      <div data-tour="nav-actions" className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="outline" onClick={reset} disabled={saving}>
          Reset to default
        </Button>
      </div>
    </div>
  );
}
