'use client';

import { History, Loader2, Plus, RotateCcw, Sparkles, Tag, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  archiveCategoryAction,
  createCategoryAction,
  restoreCategoryAction,
  setupSportsCategoriesAction,
  updateCategoryAction,
} from '@/server/actions/categories';
import {
  setCategoryPublicVisibilityAction,
  type CategoryPublicVisibility,
} from '@/server/actions/item-visibility';

import {
  countingUnitLabel,
  DEFAULT_SUBCATEGORY_PROFILES,
  SPORTS_SUBCATEGORIES,
  TRACKING_MODE_LABELS,
  type CountingUnit,
  type SportsSubcategoryKey,
  type SubcategoryTrackingProfile,
  type TrackingMode,
} from '@stockpilot/core';

import {
  EMPTY_TRACKING_PROFILE_DRAFT,
  isTrackingProfileComplete,
  TrackingProfileEditor,
} from './tracking-profile-editor';

const CUSTOM_SUBCATEGORY = '__custom';
const NO_SUBCATEGORY = '__none';

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  supports_sizes: boolean;
  public_visibility: CategoryPublicVisibility;
  parent_id: string | null;
  tracking_mode: TrackingMode | null;
  sports_subcategory_key: string | null;
  tracking_profile: SubcategoryTrackingProfile | null;
  /** `categories.default_unit_of_measure` — the counting unit half of what
   *  Task 12 promises this screen shows ("its resolved mode and counting
   *  unit"). Null means "inherit", exactly as the server reads it. */
  default_unit_of_measure: string | null;
}

interface FormValues {
  name: string;
  description: string;
  color: string;
  supportsSizes: boolean;
  isSportsSubcategory: boolean;
  subcategoryKey: string;
  trackingModeOverride: string;
}

const PRESET_COLORS = ['#6366f1', '#10b981', '#f97316', '#0ea5e9', '#a855f7', '#ec4899', '#64748b', '#eab308'];

/**
 * Resolves what the Tracking column shows for a row (Task 12). Returns null
 * for a category with nothing sports-related at all — the regression
 * requirement that a plain category "must render with no sports affordances".
 *
 * The COUNTING UNIT was missing here until the live verification caught it: a
 * Shoes row read `Tracking: Quantity by variant` and never said "pairs",
 * against a Task 12 acceptance line that asks for "its resolved mode and
 * counting unit". It walks the SAME fallback chain the server's
 * `resolveTrackingProfile` uses — own column, then the parent's, then the
 * subcategory profile's default, then `unit` — so this screen can never
 * advertise a unit the server would not actually stamp on an item.
 */
function resolveTrackingDisplay(
  row: CategoryRow,
  parent: CategoryRow | null,
): { label: string; inherited: boolean; countingUnit: string } | null {
  const builtIn = row.sports_subcategory_key
    ? DEFAULT_SUBCATEGORY_PROFILES[row.sports_subcategory_key as SportsSubcategoryKey]
    : undefined;
  const profile = builtIn ?? row.tracking_profile ?? null;
  const explicitMode = row.tracking_mode ?? parent?.tracking_mode ?? null;
  const mode = explicitMode ?? profile?.defaultMode ?? null;
  if (!mode) return null;
  const unit = (row.default_unit_of_measure ??
    parent?.default_unit_of_measure ??
    profile?.defaultCountingUnit ??
    'unit') as CountingUnit;
  return {
    label: TRACKING_MODE_LABELS[mode],
    inherited: row.tracking_mode == null && parent?.tracking_mode != null,
    // Plural, matching the grouping preview's "Counting unit pairs" — the unit
    // names how a whole shelf is counted, not a single row.
    countingUnit: countingUnitLabel(unit, 2),
  };
}

export function CategoriesManager({
  initial,
  view = 'active',
  canManage = true,
  canManagePublicVisibility = false,
  sportsEnabled = false,
  canManageSports = false,
}: {
  initial: CategoryRow[];
  view?: 'active' | 'archived';
  /**
   * When false, hides the New / Edit / Archive / Restore action buttons
   * so viewers see a read-only list. Server-side actions still throw on
   * direct calls — this is the user-facing surface gate.
   */
  canManage?: boolean;
  /**
   * Public-catalog visibility (P3): shows the per-category Public /
   * Internal-only select. Page passes can(ctx, 'public_links:manage');
   * the server action re-asserts.
   */
  canManagePublicVisibility?: boolean;
  /** Sports module on for this org (Task 12). Gates "Set up Sports" and the
   *  per-category tracking-profile controls; the server re-asserts both. */
  sportsEnabled?: boolean;
  /** can(ctx, 'sports:manage'). Same prop-gating pattern as canManagePublicVisibility. */
  canManageSports?: boolean;
}) {
  const router = useRouter();
  const isArchivedView = view === 'archived';
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [presetParent, setPresetParent] = React.useState<CategoryRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<CategoryRow | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [restoreTarget, setRestoreTarget] = React.useState<CategoryRow | null>(null);
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  const [setupBusy, setSetupBusy] = React.useState(false);

  const byId = React.useMemo(() => new Map(initial.map((c) => [c.id, c])), [initial]);
  /**
   * A row is rendered under its parent only when that parent is in THIS list.
   * `CategoriesService.archive()` refuses to archive a category that still has
   * live children, but that check is not atomic (two admins, one archiving the
   * parent while the other adds a child), and this list is also filtered. A
   * child whose parent is absent is therefore promoted to a root rather than
   * dropped: every row renders exactly once, whatever the data does.
   */
  const isRoot = React.useCallback(
    (c: CategoryRow) => !c.parent_id || !byId.has(c.parent_id),
    [byId],
  );
  const childrenByParent = React.useMemo(() => {
    const map = new Map<string, CategoryRow[]>();
    for (const c of initial) {
      if (isRoot(c)) continue;
      const list = map.get(c.parent_id as string) ?? [];
      list.push(c);
      map.set(c.parent_id as string, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [initial, isRoot]);
  const roots = React.useMemo(
    () => initial.filter(isRoot).sort((a, b) => a.name.localeCompare(b.name)),
    [initial, isRoot],
  );
  // The whole hierarchy layout is opt-in per org, by DATA: an org that has
  // never created a subcategory has zero rows with parent_id set, so this is
  // false for every pre-Task-12 org and the render below falls through to the
  // exact old flat grid — "no sports affordances at all" by construction.
  const hasHierarchy = initial.some((c) => c.parent_id != null);

  function openNewRoot() {
    setEditing(null);
    setPresetParent(null);
    setOpen(true);
  }
  function openNewSubcategory(root: CategoryRow) {
    setEditing(null);
    setPresetParent(root);
    setOpen(true);
  }
  function openEdit(row: CategoryRow) {
    setEditing(row);
    setPresetParent(null);
    setOpen(true);
  }

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    const res = await archiveCategoryAction(archiveTarget.id);
    setArchiveBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`"${archiveTarget.name}" archived.`);
    setArchiveTarget(null);
    router.refresh();
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    const res = await restoreCategoryAction(restoreTarget.id);
    setRestoreBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`"${restoreTarget.name}" restored.`);
    setRestoreTarget(null);
    router.refresh();
  }

  async function handleSetupSports() {
    setSetupBusy(true);
    const res = await setupSportsCategoriesAction();
    setSetupBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      res.data.created.length === 0
        ? 'Sports categories are already set up.'
        : `Created ${res.data.created.length} Sports subcategor${res.data.created.length === 1 ? 'y' : 'ies'}.`,
    );
    router.refresh();
  }

  function renderCard(row: CategoryRow, parent: CategoryRow | null) {
    const tracking = sportsEnabled ? resolveTrackingDisplay(row, parent) : null;
    return (
      <div
        key={row.id}
        className="group flex items-start gap-3 rounded-xl border bg-card p-4 transition-shadow hover:shadow-md"
      >
        <span
          aria-hidden
          className="mt-1 h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: row.color ?? '#94a3b8' }}
        />
        <div className="flex-1 min-w-0">
          {isArchivedView || !canManage ? (
            <span className="block text-left font-medium">{row.name}</span>
          ) : (
            <button
              type="button"
              onClick={() => openEdit(row)}
              className="block text-left font-medium transition-colors hover:text-primary"
            >
              {row.name}
            </button>
          )}
          {row.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.description}</p>
          )}
          {tracking && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Tracking: <span className="font-medium text-foreground">{tracking.label}</span>
              {tracking.inherited && ' (inherited)'}
              {' · Counting unit: '}
              <span className="font-medium text-foreground">{tracking.countingUnit}</span>
            </p>
          )}
          {canManagePublicVisibility && <CategoryVisibilityControl category={row} />}
        </div>
        {canManage &&
          (isArchivedView ? (
            <Button variant="outline" size="sm" onClick={() => setRestoreTarget(row)}>
              <RotateCcw className="h-3.5 w-3.5" /> Restore
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => setArchiveTarget(row)}
              aria-label={`Archive ${row.name}`}
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          ))}
      </div>
    );
  }

  const parentId = editing?.parent_id ?? presetParent?.id ?? null;
  const parentRow = parentId ? (byId.get(parentId) ?? presetParent) : null;

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-2">
        <ArchiveViewToggle view={view} />
        <div className="flex items-center gap-2">
          {sportsEnabled && canManageSports && !isArchivedView && (
            <Button variant="outline" onClick={handleSetupSports} disabled={setupBusy}>
              {setupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Set up Sports
            </Button>
          )}
          {canManage && !isArchivedView && (
            <Button variant="gradient" onClick={openNewRoot}>
              <Plus className="h-4 w-4" /> New category
            </Button>
          )}
        </div>
      </div>

      {canManagePublicVisibility && initial.length > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Public visibility:</span>{' '}
          &lsquo;Internal only&rsquo; removes every item in the category from the shared
          public pool on public request links, regardless of the items&apos; own settings.
          Items hand-picked on a specific link stay visible on that link unless the item
          itself is Hidden.
        </p>
      )}

      {initial.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={History}
            title="No archived categories"
            description="Categories you archive show up here so you can restore them later."
          />
        ) : (
          <EmptyState
            icon={Tag}
            title="No categories yet"
            description="Group items by type so reports, filters, and dashboards stay readable. Use the New category button above to add one."
          />
        )
      ) : isArchivedView || !hasHierarchy ? (
        // Flat grid — byte-identical to the pre-Task-12 layout. This is what
        // every org that has never created a subcategory (i.e. every org
        // today) continues to see, and what the archived view always shows.
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {initial.map((row) => renderCard(row, null))}
        </div>
      ) : (
        <div className="space-y-4">
          {roots.map((root) => {
            const children = childrenByParent.get(root.id) ?? [];
            return (
              <div key={root.id} className="rounded-xl border bg-card p-4">
                {renderCard(root, null)}
                <div className="mt-3 space-y-2 border-l border-border pl-4">
                  {children.map((child) => renderCard(child, root))}
                </div>
                {canManage && (
                  <div className="mt-2 pl-4">
                    <Button variant="outline" size="sm" onClick={() => openNewSubcategory(root)}>
                      <Plus className="h-3.5 w-3.5" /> Add subcategory
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CategoryDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        parentId={parentId}
        parentRow={parentRow}
        sportsEnabled={sportsEnabled}
        canManageSports={canManageSports}
      />

      <DestructiveConfirm
        open={archiveTarget !== null}
        onOpenChange={(v) => {
          if (!v) setArchiveTarget(null);
        }}
        title={archiveTarget ? `Archive "${archiveTarget.name}"?` : 'Archive category?'}
        description={
          <>
            The category is hidden from filters and item forms. Items already in this category
            keep their assignment until you move them. You can restore it from the{' '}
            <strong>Archived view</strong>.
          </>
        }
        confirmLabel="Archive"
        pending={archiveBusy}
        onConfirm={confirmArchive}
      />

      <DestructiveConfirm
        open={restoreTarget !== null}
        onOpenChange={(v) => {
          if (!v) setRestoreTarget(null);
        }}
        title={restoreTarget ? `Restore "${restoreTarget.name}"?` : 'Restore category?'}
        description="This brings the category back into the active list."
        confirmLabel="Restore"
        tone="primary"
        pending={restoreBusy}
        onConfirm={confirmRestore}
      />
    </>
  );
}

/** The three sports-policy keys the edit dialog can post, exactly as the
 *  update action names them. `undefined` = the key is absent from the payload. */
interface SportsPolicyPatch {
  sportsSubcategoryKey?: string | null;
  trackingMode?: TrackingMode | null;
  trackingProfile?: SubcategoryTrackingProfile | null;
}

/** Key-order-independent value identity. `tracking_profile` arrives from the DB
 *  as JSON and leaves as a draft object, so a naive stringify would call two
 *  identical profiles different and resend one that never changed. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string =>
    JSON.stringify(v ?? null, (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val as object).sort(([x], [y]) => x.localeCompare(y)))
        : val,
    );
  return norm(a) === norm(b);
}

/**
 * Strips every sports key whose value the row already holds, so an edit that did
 * not touch the sports section posts no sports field at all.
 *
 * This is what makes ABSENT reachable from the UI. The server's whole
 * absent-vs-null contract was unusable while the dialog sent all three keys on
 * every save — see the comment at the call site.
 */
function dropUnchangedSportsFields(
  patch: SportsPolicyPatch,
  current: CategoryRow,
): SportsPolicyPatch {
  const currentBy: Record<keyof SportsPolicyPatch, unknown> = {
    sportsSubcategoryKey: current.sports_subcategory_key,
    trackingMode: current.tracking_mode,
    trackingProfile: current.tracking_profile,
  };
  const out: SportsPolicyPatch = {};
  for (const key of Object.keys(patch) as Array<keyof SportsPolicyPatch>) {
    const next = patch[key];
    // A key the builder already left out stays out — `trackingMode: undefined`
    // on the built-in branch means "no override", which is absence, not a clear.
    if (next === undefined) continue;
    if (sameValue(next, currentBy[key])) continue;
    Object.assign(out, { [key]: next });
  }
  return out;
}

function CategoryDialog({
  open,
  onOpenChange,
  editing,
  parentId,
  parentRow,
  sportsEnabled,
  canManageSports,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: CategoryRow | null;
  /** Set when creating a subcategory (via "Add subcategory") or editing one. */
  parentId: string | null;
  parentRow: CategoryRow | null;
  sportsEnabled: boolean;
  canManageSports: boolean;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormValues>({
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      name: '',
      description: '',
      color: '#6366f1',
      supportsSizes: false,
      isSportsSubcategory: false,
      subcategoryKey: NO_SUBCATEGORY,
      trackingModeOverride: '',
    },
  });
  // The custom subcategory's full profile. Plain state (not react-hook-form) —
  // same reasoning as the group-identity fields in sports-fields.tsx: RHF
  // would validate the whole nested object on every keystroke.
  const [profileDraft, setProfileDraft] = React.useState<SubcategoryTrackingProfile>(
    EMPTY_TRACKING_PROFILE_DRAFT,
  );

  const showSportsSection = sportsEnabled && canManageSports && parentId != null;

  React.useEffect(() => {
    if (!open) return;
    const builtInKey =
      editing?.sports_subcategory_key &&
      (SPORTS_SUBCATEGORIES as readonly string[]).includes(editing.sports_subcategory_key)
        ? editing.sports_subcategory_key
        : null;
    const isCustom = Boolean(editing?.sports_subcategory_key) && !builtInKey;
    reset({
      name: editing?.name ?? '',
      description: editing?.description ?? '',
      color: editing?.color ?? '#6366f1',
      supportsSizes: editing?.supports_sizes ?? false,
      isSportsSubcategory: Boolean(editing?.sports_subcategory_key),
      subcategoryKey: builtInKey ?? (isCustom ? CUSTOM_SUBCATEGORY : NO_SUBCATEGORY),
      trackingModeOverride: editing?.tracking_mode ?? '',
    });
    setProfileDraft(
      isCustom && editing?.tracking_profile ? editing.tracking_profile : EMPTY_TRACKING_PROFILE_DRAFT,
    );
  }, [open, editing, reset]);

  const subcategoryKey = watch('subcategoryKey');
  const isSportsSubcategory = watch('isSportsSubcategory');
  const isCustomSubcategory = subcategoryKey === CUSTOM_SUBCATEGORY;
  const builtInProfile =
    subcategoryKey !== CUSTOM_SUBCATEGORY && subcategoryKey !== NO_SUBCATEGORY
      ? DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey]
      : null;

  const canSubmitSports =
    !showSportsSection ||
    !isSportsSubcategory ||
    (isCustomSubcategory ? isTrackingProfileComplete(profileDraft) : subcategoryKey !== NO_SUBCATEGORY);

  const onSubmit = handleSubmit(async (values) => {
    const sportsFields =
      showSportsSection && values.isSportsSubcategory
        ? isCustomSubcategory
          ? {
              sportsSubcategoryKey: profileDraft.key,
              trackingMode: profileDraft.defaultMode,
              trackingProfile: profileDraft,
            }
          : {
              sportsSubcategoryKey: values.subcategoryKey,
              trackingMode: (values.trackingModeOverride || undefined) as TrackingMode | undefined,
              trackingProfile: null,
            }
        : showSportsSection
          ? { sportsSubcategoryKey: null, trackingMode: null, trackingProfile: null }
          : {};

    const payload = {
      name: values.name,
      description: values.description || undefined,
      color: values.color || undefined,
      supportsSizes: values.supportsSizes,
      parentId,
      // ABSENT means "untouched"; NULL means "clear it". The server has read the
      // two apart since the Task 12 fix (`touchesSportsPolicy` is
      // `patch[k] !== undefined`, and update()'s merge is
      // `patch.X !== undefined ? (patch.X ?? null) : current.X`) — this dialog
      // just never said "untouched". It spread all three sports keys on EVERY
      // save the section was on screen for, including three explicit nulls on
      // the not-a-sports-subcategory branch, so a plain RENAME posted a
      // sports-policy write: it demanded `sports:manage` and re-ran
      // `assertSportsRootChildValid` against an unchanged row, refusing the
      // rename of a profile-less Sports-root child with
      // SPORTS_SUBCATEGORY_REQUIRED.
      //
      // Same rule the parentId half already follows (the dialog resends the
      // current parent and the server only treats a genuine MOVE as a move),
      // applied where it was missing. Dropping a key the human did not touch
      // takes nothing away: clearing a profile is still an explicit null, still
      // gated, still refused when the resulting state is incomplete.
      //
      // CREATE is untouched — there is no prior row to compare against, and a
      // new category states its whole sports intent by definition.
      ...(editing ? dropUnchangedSportsFields(sportsFields, editing) : sportsFields),
    };
    const res = editing
      ? await updateCategoryAction(editing.id, payload)
      : await createCategoryAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? 'Category updated.' : 'Category created.');
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit category' : parentId ? 'New subcategory' : 'New category'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {parentRow && (
            <p className="text-xs text-muted-foreground">
              Under: <span className="font-medium text-foreground">{parentRow.name}</span>
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Electronics" {...register('name', { required: true })} />
            {errors.name && <p className="text-xs text-destructive">Name is required.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">
              Description
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id="description" rows={2} {...register('description')} />
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setValue('color', c)}
                  className="h-7 w-7 rounded-full ring-offset-2 ring-offset-background transition-all data-[selected=true]:ring-2 data-[selected=true]:ring-ring"
                  data-selected={watch('color') === c}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          <label
            htmlFor="cat-supports-sizes"
            className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer"
          >
            <input
              id="cat-supports-sizes"
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              {...register('supportsSizes')}
            />
            <div className="space-y-0.5">
              <span className="block text-sm font-medium">
                Has size variants (S, M, L, XL…)
              </span>
              <p className="text-muted-foreground text-xs">
                When on, items in this category get a Sizes selector on the
                item form, and saving creates one variant per chosen size.
              </p>
            </div>
          </label>

          {showSportsSection && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <label
                htmlFor="is-sports-subcategory"
                className="flex items-start gap-3 cursor-pointer"
              >
                <input
                  id="is-sports-subcategory"
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  {...register('isSportsSubcategory')}
                />
                <div className="space-y-0.5">
                  <span className="block text-sm font-medium">This is a Sports subcategory</span>
                  <p className="text-muted-foreground text-xs">
                    Sports subcategories carry a tracking profile — how items under them are
                    counted, what attributes they take, and whether a serial is required.
                  </p>
                </div>
              </label>

              {isSportsSubcategory && (
                <div className="space-y-3 pl-7">
                  <div className="space-y-1.5">
                    <Label htmlFor="subcategory-key">Subcategory type</Label>
                    <Select
                      value={subcategoryKey}
                      onValueChange={(v) => {
                        setValue('subcategoryKey', v);
                        setValue('trackingModeOverride', '');
                      }}
                    >
                      <SelectTrigger id="subcategory-key">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_SUBCATEGORY}>Choose a type…</SelectItem>
                        {SPORTS_SUBCATEGORIES.map((key) => (
                          <SelectItem key={key} value={key}>
                            {DEFAULT_SUBCATEGORY_PROFILES[key].label}
                          </SelectItem>
                        ))}
                        <SelectItem value={CUSTOM_SUBCATEGORY}>Custom…</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {builtInProfile && (
                    <div className="space-y-1.5">
                      <Label htmlFor="tracking-mode-override">
                        Tracking mode
                        <span className="ml-1 font-normal text-muted-foreground">
                          (default: {TRACKING_MODE_LABELS[builtInProfile.defaultMode]})
                        </span>
                      </Label>
                      <Select
                        value={watch('trackingModeOverride') || '__default'}
                        onValueChange={(v) => setValue('trackingModeOverride', v === '__default' ? '' : v)}
                      >
                        <SelectTrigger id="tracking-mode-override">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default">Use the default</SelectItem>
                          {builtInProfile.allowedModes.map((m) => (
                            <SelectItem key={m} value={m}>
                              {TRACKING_MODE_LABELS[m]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {isCustomSubcategory && (
                    <TrackingProfileEditor value={profileDraft} onChange={setProfileDraft} />
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={isSubmitting || !canSubmitSports}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                'Save changes'
              ) : (
                'Create category'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-category public-visibility select (P3 public-catalog controls).
 * 'internal_only' pulls the whole category out of the shared-pool branch of
 * every public link's eligibility predicate (migration 0261); explicit
 * per-link item entries are unaffected. Errors render inline under the
 * select (recurring bug pattern #20), and the value reverts on failure.
 */
function CategoryVisibilityControl({ category }: { category: CategoryRow }) {
  const router = useRouter();
  const [value, setValue] = React.useState<CategoryPublicVisibility>(
    category.public_visibility,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onChange(next: string) {
    const visibility = next as CategoryPublicVisibility;
    if (visibility === value || busy) return;
    const previous = value;
    setBusy(true);
    setError(null);
    setValue(visibility);
    const res = await setCategoryPublicVisibilityAction({
      categoryId: category.id,
      visibility,
    });
    setBusy(false);
    if (!res.ok) {
      setValue(previous);
      setError(res.error.message);
      return;
    }
    toast.success(
      visibility === 'public'
        ? `"${category.name}" can appear in the public pool again.`
        : `"${category.name}" removed from the public pool.`,
    );
    router.refresh();
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-1.5">
        <Select value={value} onValueChange={onChange} disabled={busy}>
          <SelectTrigger
            className="h-7 w-[150px] text-xs"
            aria-label={`Public visibility for ${category.name}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="internal_only">Internal only</SelectItem>
          </SelectContent>
        </Select>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

// Required by Radix; suppress unused warnings on DialogTrigger import.
void DialogTrigger;
