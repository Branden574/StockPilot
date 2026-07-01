'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ImagePlus, Loader2, ScanLine, Upload, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { AddSizedVariantsButton } from '@/components/inventory/add-sized-variants-button';
import { CustomFieldsInputs } from '@/components/inventory/custom-fields-inputs';
// Dynamic import + conditional render: IsbnScanner pulls in the
// Dialog tree and BarcodeDetector usage; only ships in the bundle
// when the user actually opens the scanner. ssr:false because the
// scanner relies on browser APIs.
const IsbnScanner = dynamic(
  () =>
    import('@/components/inventory/isbn-scanner').then((m) => ({
      default: m.IsbnScanner,
    })),
  { ssr: false },
);
import { StockAdjustDialog } from '@/components/inventory/stock-adjust-dialog';
import { Button } from '@/components/ui/button';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
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
import { capture } from '@/lib/analytics';
import { CRATE_COLORS, GRADES } from '@/lib/book-storage';
import { compressImageVariants } from '@/lib/image-variants';
import { resolveListReturnHref } from '@/lib/last-list-url';
import { generateSku, cn } from '@/lib/utils';
import {
  bulkCreateSizedVariantsAction,
  createItemAction,
  updateItemAction,
} from '@/server/actions/inventory';
import { createImageUploadAction, recordImageAction } from '@/server/actions/item-images';
import { setItemTagsAction } from '@/server/actions/tags';

import {
  createItemSchema,
  type CreateItemInput,
  type CustomFieldDefinition,
  type UpdateItemInput,
} from '@stockpilot/core';

type SizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL' | 'XXXXXL';
const ALL_SIZES: ReadonlyArray<SizeCode> = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'];

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// HEIC + HEIF added so iPhone Safari (which ships HEIC by default
// unless the user has flipped Camera > Format to "Most Compatible")
// can upload directly. compressImageVariants transcodes via
// heic2any before the normal canvas pipeline.
const IMAGE_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
];

interface StagedImage {
  file: File;
  previewUrl: string;
}

export interface ItemFormDefaults extends Partial<CreateItemInput> {
  id?: string;
  shelfLifeDays?: number | null;
  expiryPolicy?: 'none' | 'warn' | 'block';
}

interface ItemFormProps {
  defaults?: ItemFormDefaults;
  categories: Array<{ id: string; name: string; supports_sizes?: boolean }>;
  locations: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  /** Every tag in the org. Empty array hides the Tags pill row entirely. */
  tags?: Array<{ id: string; name: string; color: string | null }>;
  /** Tag ids currently applied to the item being edited. Ignored on create. */
  initialTagIds?: string[];
  /** All warehouses the current user can write to. */
  warehouses: Array<{ id: string; name: string }>;
  /** Every (warehouse_id, charter_id) pair in the org. Used to filter charter options. */
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  /** All charters in the org (for label lookup). */
  charters: Array<{ id: string; name: string }>;
  /** Forced warehouse (for warehouse-scoped users) — picker is hidden when set. */
  forcedWarehouseId?: string | null;
  warehouseLabel: string;
  charterLabel: string;
  /**
   * Item type — drives small form variations:
   *   'product'  (default) → "Barcode"
   *   'book'              → "ISBN" + Author field that writes custom_fields.author
   */
  itemType?: 'product' | 'book' | 'asset' | 'consumable';
  /**
   * Optional same-origin path the form returns to after a successful
   * save (or when the user clicks Cancel). Used by the edit-page flow
   * to honor the `?return=` round-trip back to the list URL.
   * When omitted, the form keeps its current behavior:
   *   - on create: router.push to the new item's detail page
   *   - on edit:   router.refresh in place
   *   - on cancel: onDone() callback (no route change)
   */
  returnHref?: string;
  onDone?: () => void;
  /**
   * When true, the form includes `is_rental: true` in the submit payload
   * so the created item is classified as a rental asset. The rental
   * toggle (if any) is hidden from the UI. Used by
   * /dashboard/rentals/items/new to ensure items created there always
   * belong to the rental catalog. Default: undefined (behaves as false).
   */
  isRentalFixed?: boolean;
  /**
   * The org's ACTIVE item custom field definitions. Rendered by
   * <CustomFieldsInputs> alongside the hardcoded rack/author inputs. Empty
   * array (or omitted) → no generic custom fields shown.
   */
  customFieldDefs?: CustomFieldDefinition[];
  /** Phase 5: when true, show the Lot & expiry section (lot_serial module on). */
  lotSerialEnabled?: boolean;
}

export function ItemForm({
  defaults,
  categories,
  locations,
  suppliers,
  tags = [],
  initialTagIds = [],
  warehouses,
  warehouseCharters,
  charters,
  forcedWarehouseId,
  warehouseLabel,
  charterLabel,
  itemType = 'product',
  returnHref,
  onDone,
  isRentalFixed = false,
  customFieldDefs = [],
  lotSerialEnabled = false,
}: ItemFormProps) {
  const router = useRouter();
  const isEdit = Boolean(defaults?.id);
  const [staged, setStaged] = React.useState<StagedImage[]>([]);
  const [uploadingImages, setUploadingImages] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  // Revoke blob URLs on unmount.
  React.useEffect(() => {
    return () => {
      staged.forEach((s) => URL.revokeObjectURL(s.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const accepted: StagedImage[] = [];
    for (const file of list) {
      if (!IMAGE_ACCEPT.includes(file.type)) {
        toast.error(`"${file.name}" isn't a supported image type. Use PNG, JPG, WEBP, or AVIF.`);
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        toast.error(`"${file.name}" is over 10 MB. Pick a smaller image.`);
        continue;
      }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    if (accepted.length > 0) setStaged((s) => [...s, ...accepted]);
  }

  function removeStaged(idx: number) {
    setStaged((s) => {
      const target = s[idx];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return s.filter((_, i) => i !== idx);
    });
  }

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CreateItemInput>({
    resolver: zodResolver(createItemSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      name: defaults?.name ?? '',
      sku: defaults?.sku ?? '',
      barcode: defaults?.barcode ?? '',
      modelNumber: defaults?.modelNumber ?? '',
      description: defaults?.description ?? '',
      categoryId: defaults?.categoryId ?? null,
      supplierId: defaults?.supplierId ?? null,
      primaryLocationId: defaults?.primaryLocationId ?? null,
      warehouseId: defaults?.warehouseId ?? forcedWarehouseId ?? null,
      charterId: defaults?.charterId ?? null,
      unitCost: defaults?.unitCost ?? 0,
      retailPrice: defaults?.retailPrice ?? 0,
      quantityOnHand: defaults?.quantityOnHand ?? 0,
      reorderPoint: defaults?.reorderPoint ?? 0,
      reorderQuantity: defaults?.reorderQuantity ?? 0,
      unitOfMeasure: defaults?.unitOfMeasure ?? 'unit',
      binLocation: defaults?.binLocation ?? '',
      trackingType: defaults?.trackingType ?? 'none',
      shelfLifeDays: defaults?.shelfLifeDays ?? null,
      expiryPolicy: defaults?.expiryPolicy ?? 'warn',
      itemType: defaults?.itemType ?? itemType,
      status: defaults?.status ?? 'active',
      customFields: defaults?.customFields ?? {},
    },
  });

  // Keep the read-only On-hand input in sync with server data after a
  // stock adjustment. RHF only honors defaultValues at mount, so without
  // this the displayed quantity stays stale until the user clicks Save
  // and refreshes — even though router.refresh() re-fetched the server
  // tree and `defaults.quantityOnHand` is already up to date.
  // We only sync in edit mode (input is disabled there); in create mode
  // the field is user-editable and we must not stomp on their typing.
  React.useEffect(() => {
    if (!isEdit) return;
    const next = defaults?.quantityOnHand;
    if (typeof next === 'number') {
      setValue('quantityOnHand', next, { shouldDirty: false, shouldTouch: false });
    }
  }, [isEdit, defaults?.quantityOnHand, setValue]);

  const isBook = itemType === 'book' || (defaults?.itemType ?? itemType) === 'book';
  const cfDefault =
    (defaults?.customFields as Record<string, unknown> | undefined) ?? {};
  const [author, setAuthor] = React.useState<string>(
    isBook ? String(cfDefault.author ?? '') : '',
  );
  // Rack number / row inputs. Books write to custom_fields.book_rack_*
  // (kept that way so historical data keeps matching); everything else
  // writes to neutral custom_fields.rack_* keys.
  const [rackNumber, setRackNumber] = React.useState<string>(
    isBook
      ? String(cfDefault.book_rack_number ?? '')
      : String(cfDefault.rack_number ?? ''),
  );
  const [rackRow, setRackRow] = React.useState<string>(
    isBook
      ? String(cfDefault.book_rack_row ?? '')
      : String(cfDefault.rack_row ?? ''),
  );
  const [crateColor, setCrateColor] = React.useState<string>(
    isBook ? String(cfDefault.book_crate_color ?? '') : '',
  );
  const [crateNumber, setCrateNumber] = React.useState<string>(
    isBook ? String(cfDefault.book_crate_number ?? '') : '',
  );
  const [grade, setGrade] = React.useState<string>(
    isBook ? String(cfDefault.book_grade ?? '') : '',
  );
  // Generic per-org custom field values. Seeded from the item's stored
  // custom_fields, scoped to the keys this org has defined (reserved/hardcoded
  // keys like rack_*/author are handled by their own inputs above and are
  // never definable, so there's no overlap). The component edits a copy and
  // emits the full next object; we merge it into customFields at submit.
  const [customFieldValues, setCustomFieldValues] = React.useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const def of customFieldDefs) {
      if (def.archived) continue;
      if (cfDefault[def.fieldKey] !== undefined) seed[def.fieldKey] = cfDefault[def.fieldKey];
    }
    return seed;
  });
  const [scannerOpen, setScannerOpen] = React.useState(false);
  /**
   * Size-variant selection. Only meaningful when the chosen category has
   * supports_sizes = true AND this is a create form (variants don't
   * apply when editing one existing row). Each entry holds the size
   * code + on-hand qty for that variant.
   */
  const [selectedSizes, setSelectedSizes] = React.useState<
    Array<{ size: SizeCode; quantity: number }>
  >([]);
  // Drop sized selections whenever the category changes. Avoids stale
  // picks sticking when the user toggles between a size-flagged
  // category and a non-flagged one.
  const watchedCategoryId = watch('categoryId');
  React.useEffect(() => {
    setSelectedSizes([]);
  }, [watchedCategoryId]);
  const [lookingUp, setLookingUp] = React.useState(false);

  // Tag selection — independent of RHF because tags don't live on the
  // inventory_items row; they're persisted to item_tags via a separate
  // server action after the item save resolves.
  const [selectedTagIds, setSelectedTagIds] = React.useState<Set<string>>(
    () => new Set(initialTagIds),
  );
  const initialTagIdsKey = React.useMemo(
    () => [...initialTagIds].sort().join(','),
    [initialTagIds],
  );
  // Re-seed when the parent edit page revalidates and ships a new
  // initialTagIds prop (e.g. the user edits tags elsewhere and comes
  // back). Stable initialTagIds reference on the same value won't
  // re-trigger thanks to the join-string memo.
  React.useEffect(() => {
    setSelectedTagIds(new Set(initialTagIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTagIdsKey]);
  function toggleTag(id: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleIsbnDetected(isbn: string) {
    // The scan succeeded — surface the value immediately and keep it
    // populated whether or not the metadata lookup finds anything.
    // Educational/textbook publishers (HMH, Pearson, McGraw-Hill, etc.)
    // often aren't in Google Books or Open Library, so a miss is common.
    setValue('barcode', isbn, { shouldDirty: true });
    // Non-book items just want the barcode populated. Skip the books
    // lookup so we don't toast "ISBN not found" for a regular UPC.
    if (!isBook) {
      toast.success(`Barcode ${isbn} captured.`);
      return;
    }
    setLookingUp(true);
    try {
      const res = await fetch(`/api/books/lookup?isbn=${encodeURIComponent(isbn)}`);
      if (!res.ok) {
        toast.message(`ISBN ${isbn} saved`, {
          description:
            "We couldn't find this ISBN in any of our catalog sources — type the title and author below.",
        });
        return;
      }
      const data = (await res.json()) as {
        title: string | null;
        authors: string[];
        description: string | null;
        grade: string | null;
      };
      if (data.title) setValue('name', data.title, { shouldDirty: true });
      if (data.description)
        setValue('description', data.description.slice(0, 5000), { shouldDirty: true });
      if (data.authors.length > 0) setAuthor(data.authors.join(', '));
      // Only prefill grade when the user hasn't already set one — avoid
      // clobbering a manual choice if they re-scan an ISBN.
      if (data.grade && !grade) setGrade(data.grade);
      toast.success('Book details filled in from ISBN lookup.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't look up this ISBN. Check your network and try again.");
    } finally {
      setLookingUp(false);
    }
  }

  // Non-book UPC enrichment — fills name/description/modelNumber from
  // the upc-lookup chain (UPCitemdb + Gemini description-only). Books
  // already have their own ISBN flow via handleIsbnDetected above; this
  // is purely for the "regular product" path.
  async function handleUpcLookup() {
    const code = (watch('barcode') ?? '').trim();
    if (!code) {
      toast.error('Type or scan a barcode first, then click Lookup.');
      return;
    }
    setLookingUp(true);
    try {
      const res = await fetch(`/api/v1/items/upc-lookup?upc=${encodeURIComponent(code)}`);
      if (res.status === 404) {
        toast.message(`UPC ${code} not found`, {
          description:
            "We couldn't find this product in our external sources. Fill the rest in by hand.",
        });
        return;
      }
      if (!res.ok) {
        toast.error("Lookup failed. Check your network and try again.");
        return;
      }
      const data = (await res.json()) as {
        source: string;
        existsInInventory: boolean;
        itemId?: string;
        enrichment: {
          name: string;
          description: string | null;
          brand: string | null;
          modelNumber: string | null;
          imageUrl: string | null;
        };
      };
      if (data.existsInInventory) {
        toast.message('Already in inventory', {
          description: `This barcode is already on "${data.enrichment.name}". Open that item to edit it.`,
        });
        return;
      }
      if (data.enrichment.name) setValue('name', data.enrichment.name, { shouldDirty: true });
      if (data.enrichment.description)
        setValue('description', data.enrichment.description.slice(0, 5000), {
          shouldDirty: true,
        });
      if (data.enrichment.modelNumber)
        setValue('modelNumber', data.enrichment.modelNumber, { shouldDirty: true });
      toast.success(
        data.source === 'ai-fallback'
          ? 'Found it. Description was AI-generated — review before saving.'
          : 'Product details filled in.',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't look up that UPC.");
    } finally {
      setLookingUp(false);
    }
  }

  const watchedWarehouseId = watch('warehouseId') ?? forcedWarehouseId ?? null;
  const watchedCharterId = watch('charterId') ?? null;
  const charterById = React.useMemo(
    () => new Map(charters.map((c) => [c.id, c.name])),
    [charters],
  );
  const allowedCharterIds = React.useMemo(
    () =>
      new Set(
        watchedWarehouseId
          ? warehouseCharters
              .filter((wc) => wc.warehouse_id === watchedWarehouseId)
              .map((wc) => wc.charter_id)
          : [],
      ),
    [warehouseCharters, watchedWarehouseId],
  );
  const allowedCharters = React.useMemo(
    () =>
      [...allowedCharterIds]
        .map((id) => ({ id, name: charterById.get(id) ?? id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allowedCharterIds, charterById],
  );

  // If the warehouse changes and the current charter no longer fits, clear it.
  React.useEffect(() => {
    if (watchedCharterId && !allowedCharterIds.has(watchedCharterId)) {
      setValue('charterId', null);
    }
  }, [watchedCharterId, allowedCharterIds, setValue]);

  async function uploadStagedImages(itemId: string) {
    if (staged.length === 0) return { uploaded: 0, failed: 0 };
    setUploadingImages(true);
    let uploaded = 0;
    let failed = 0;
    try {
      for (let i = 0; i < staged.length; i++) {
        const item = staged[i];
        if (!item) continue;
        // Generate master + thumb + LQIP from a single decode. Same
        // helper the item-detail uploader uses so create-flow uploads
        // populate the same thumb_path + lqip columns and get the
        // same instant-thumb / blur-placeholder treatment in lists.
        const { master, thumbBlob, lqip } = await compressImageVariants(item.file);
        const ext = (master.name.split('.').pop() ?? 'jpg').toLowerCase();
        const presign = await createImageUploadAction({ itemId, fileExt: ext });
        if (!presign.ok) {
          failed++;
          continue;
        }
        const [masterRes, thumbRes] = await Promise.all([
          fetch(presign.data.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': master.type, 'x-upsert': 'true' },
            body: master,
          }),
          thumbBlob
            ? fetch(presign.data.thumbSignedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'image/webp', 'x-upsert': 'true' },
                body: thumbBlob,
              })
            : Promise.resolve(null),
        ]);
        if (!masterRes.ok) {
          failed++;
          continue;
        }
        const thumbOk = thumbRes ? thumbRes.ok : false;
        const record = await recordImageAction({
          itemId,
          storagePath: presign.data.path,
          thumbPath: thumbOk ? presign.data.thumbPath : null,
          lqip,
          isFirst: i === 0,
        });
        if (record.ok) uploaded++;
        else failed++;
      }
    } finally {
      setUploadingImages(false);
    }
    return { uploaded, failed };
  }

  const onSubmit = handleSubmit(async (values) => {
    // Sized-variant create path. Triggered only when the chosen
    // category has supports_sizes = true AND the user picked at least
    // one size on a new item. Bulk inserts one row per size, then
    // routes back to the Inventory list (each variant gets its own
    // detail page so a single-item redirect would be wrong).
    const selectedCategory = categories.find((c) => c.id === values.categoryId);
    if (
      !isEdit &&
      selectedCategory?.supports_sizes &&
      selectedSizes.length > 0
    ) {
      if (!values.categoryId || !values.warehouseId) {
        toast.error('Pick a category and warehouse before saving variants.');
        return;
      }
      const num = rackNumber.trim();
      const row = rackRow.trim().toUpperCase();
      const composedBin = num ? (row ? `${num}-${row}` : num) : null;
      // TODO: bulkCreateSizedVariantsAction schema needs `rackNumber` and `rackRow` fields added by the inventory-service agent. The service writes them into per-row custom_fields.rack_number/rack_row.
      const res = await bulkCreateSizedVariantsAction({
        baseName: values.name,
        baseSku: values.sku?.trim() || null,
        baseBarcode: values.barcode?.trim() || null,
        description: values.description?.trim() || null,
        categoryId: values.categoryId,
        supplierId: values.supplierId ?? null,
        warehouseId: values.warehouseId,
        charterId: values.charterId ?? null,
        primaryLocationId: values.primaryLocationId ?? null,
        binLocation: composedBin,
        rackNumber: num || null,
        rackRow: row || null,
        retailPrice: values.retailPrice,
        unitCost: values.unitCost,
        reorderPoint: values.reorderPoint,
        reorderQuantity: values.reorderQuantity,
        unitOfMeasure: values.unitOfMeasure,
        // Per-org custom fields entered in the "Additional fields" section apply
        // to every variant. The service strips reserved keys + runs the
        // authoritative required-field gate, so this path no longer silently
        // drops them. Pass undefined when empty to keep the payload lean.
        customFields:
          Object.keys(customFieldValues).length > 0 ? customFieldValues : undefined,
        variants: selectedSizes,
      } as Parameters<typeof bulkCreateSizedVariantsAction>[0]);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }

      // Photo upload for the sized-bulk flow. The single-item path
      // below at line ~512 only handles `res.data.id`; this branch
      // returned early before the fix and silently dropped any
      // staged photos. Storage paths are item-scoped (per
      // ItemImagesService.createUploadUrl), so each variant needs
      // its own copy — there's no shared-storage shortcut without a
      // schema change. We loop variants and upload N×M times.
      const createdIds = res.data.ids ?? [];
      let totalUploaded = 0;
      let totalFailed = 0;
      if (staged.length > 0 && createdIds.length > 0) {
        for (const variantId of createdIds) {
          const r = await uploadStagedImages(variantId);
          totalUploaded += r.uploaded;
          totalFailed += r.failed;
        }
      }

      const expected = staged.length * createdIds.length;
      if (expected === 0) {
        toast.success(
          `Created ${res.data.created} variant${res.data.created === 1 ? '' : 's'}.`,
        );
      } else if (totalFailed === 0) {
        toast.success(
          `Created ${res.data.created} variants with ${staged.length} photo${staged.length === 1 ? '' : 's'} each.`,
        );
      } else {
        toast.warning(
          `Created ${res.data.created} variants. ${totalUploaded} of ${expected} photo uploads succeeded — ${totalFailed} failed.`,
        );
      }
      onDone?.();
      // Honor the live list URL the user came from (page, search,
      // filters, sort) so they don't get bounced to page 1.
      // resolveListReturnHref reads sessionStorage written by the
      // list table on every render.
      router.push(
        resolveListReturnHref(
          isBook ? '/dashboard/books' : '/dashboard/inventory',
          returnHref,
        ),
      );
      return;
    }

    // Merge custom fields before submit. Books get the book_* prefix
    // for rack/crate; everything else uses the neutral rack_* keys.
    // Empty fields are omitted so we don't overwrite an existing value
    // with an empty string on edit.
    const mergedValues = isBook
      ? (() => {
          const num = rackNumber.trim();
          const row = rackRow.trim().toUpperCase();
          // Explicitly delete rack keys before re-adding so emptying
          // the inputs on edit actually clears the stored value
          // instead of being preserved by the spread merge.
          const baseCf = { ...(values.customFields ?? {}) } as Record<string, unknown>;
          delete baseCf.book_rack_number;
          delete baseCf.book_rack_row;
          // Drop every defined custom-field key first so clearing an input on
          // edit actually removes the stored value (the spread below only adds
          // the keys still present in customFieldValues).
          for (const def of customFieldDefs) delete baseCf[def.fieldKey];
          // Generic per-org custom fields write last under their own keys.
          // They can never collide with a reserved key (book_*/author/size/
          // isbn*/rack_* — the full set in @stockpilot/core's
          // RESERVED_CUSTOM_FIELD_KEYS, which the action + service reject at
          // definition time), so the dedicated inputs below never fight a
          // generic input over the same jsonb key.
          return {
            ...values,
            itemType: 'book' as const,
            customFields: {
              ...baseCf,
              ...customFieldValues,
              ...(author.trim() ? { author: author.trim() } : {}),
              ...(num ? { book_rack_number: num } : {}),
              ...(row ? { book_rack_row: row } : {}),
              ...(crateColor ? { book_crate_color: crateColor } : {}),
              ...(crateNumber.trim()
                ? { book_crate_number: crateNumber.trim() }
                : {}),
              ...(grade ? { book_grade: grade } : {}),
            },
          };
        })()
      : (() => {
          const num = rackNumber.trim();
          const row = rackRow.trim().toUpperCase();
          // Explicitly delete rack keys before re-adding so emptying
          // the inputs on edit actually clears the stored value
          // instead of being preserved by the spread merge.
          const baseCf = { ...(values.customFields ?? {}) } as Record<string, unknown>;
          delete baseCf.rack_number;
          delete baseCf.rack_row;
          // Drop every defined custom-field key first so clearing an input on
          // edit actually removes the stored value.
          for (const def of customFieldDefs) delete baseCf[def.fieldKey];
          // Auto-derive bin_location from rack so order pick + cycle-
          // count flows that read bin_location keep working. Format
          // matches the human label users would type: '38-A' or '38'.
          // When the user clears the rack inputs we explicitly null
          // out binLocation so the change can propagate — previously
          // the `?? values.binLocation` fallback prevented clearing.
          const composedBin = num ? (row ? `${num}-${row}` : num) : null;
          return {
            ...values,
            binLocation: composedBin,
            customFields: {
              ...baseCf,
              ...customFieldValues,
              ...(num ? { rack_number: num } : {}),
              ...(row ? { rack_row: row } : {}),
            },
          };
        })();
    // When isRentalFixed is true, inject is_rental=true into the payload
    // so the item is classified as a rental asset regardless of form state.
    const finalValues = isRentalFixed
      ? { ...mergedValues, isRental: true }
      : mergedValues;
    const action =
      isEdit && defaults?.id
        ? updateItemAction(defaults.id, finalValues as UpdateItemInput)
        : createItemAction(finalValues as CreateItemInput);
    const res = await action;
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }

    // Persist the tag selection to item_tags. Done after the item
    // save resolves so we have a guaranteed item id (creates only get
    // one back from the action). A failure here is non-fatal — the
    // item itself was already saved, so we surface a toast and let
    // the user retry from the tags row instead of rolling back the
    // whole submit.
    const itemId = res.data.id;

    // Product analytics (no-op until PostHog is configured).
    if (!isEdit) {
      capture('item_created', { is_book: isBook, is_rental: isRentalFixed });
    }

    const initialKey = [...initialTagIds].sort().join(',');
    const selectedKey = [...selectedTagIds].sort().join(',');
    if (tags.length > 0 && (!isEdit || initialKey !== selectedKey)) {
      const tagRes = await setItemTagsAction(itemId, [...selectedTagIds]);
      if (!tagRes.ok) {
        toast.warning(`Item saved, but tags couldn't be updated: ${tagRes.error.message}`);
      }
    }

    // Photo uploads are only staged in the create flow; edit flow uses the
    // ImageUploader on the item detail page directly against an existing id.
    if (!isEdit && staged.length > 0) {
      const { uploaded, failed } = await uploadStagedImages(res.data.id);
      if (failed > 0) {
        toast.warning(`Item created. ${uploaded} of ${staged.length} photos uploaded — ${failed} failed.`);
      } else {
        toast.success(`Item created with ${uploaded} photo${uploaded === 1 ? '' : 's'}.`);
      }
    } else {
      toast.success(isEdit ? 'Item updated.' : 'Item created.');
    }

    onDone?.();
    if (returnHref) {
      // Edit page passes a `returnHref` so saving bounces the user
      // back to the list URL they came from — preserves the search /
      // filter / sort / page they had typed. Both create + edit
      // honor the param when it's present. resolveListReturnHref
      // upgrades a bare list URL or detail-page returnHref to the
      // sessionStorage-cached list URL when one is available — fixes
      // the case where the user enters the edit page without a full
      // `?return=` chain (direct URL, autocomplete, cmd-click, etc).
      router.push(
        resolveListReturnHref(
          isBook ? '/dashboard/books' : '/dashboard/inventory',
          returnHref,
        ),
      );
    } else if (!isEdit) {
      // Rental items redirect to the rental-catalog item detail; regular
      // items redirect to the inventory item detail.
      const detailBase = isRentalFixed
        ? '/dashboard/rentals/items'
        : '/dashboard/inventory';
      router.push(`${detailBase}/${res.data.id}`);
    } else {
      router.refresh();
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {!isEdit && (
        <Section title="Photos">
          <p className="text-xs text-muted-foreground">
            Drop photos here. They'll upload after the item is created. PNG, JPG, WebP, AVIF — up to 10 MB each.
          </p>

          {staged.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {staged.map((s, idx) => (
                <div key={s.previewUrl} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.previewUrl} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeStaged(idx)}
                    className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-md bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  {idx === 0 && (
                    <span className="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                      Primary
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <label
            htmlFor="item-form-photos"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-6 transition-colors hover:border-primary/40 hover:bg-muted/40',
              dragOver && 'border-primary bg-primary/5',
            )}
          >
            <ImagePlus className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">Drop photos, or click to browse</p>
            <input
              id="item-form-photos"
              ref={fileInputRef}
              type="file"
              accept={IMAGE_ACCEPT.join(',')}
              multiple
              className="sr-only"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Choose files
            </Button>
          </label>
        </Section>
      )}

      <Section title="Basics">
        <Field label="Name" error={errors.name?.message}>
          <Input placeholder="Wireless mouse" autoFocus {...register('name')} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="SKU" error={errors.sku?.message} optional>
            <div className="flex gap-2">
              <Input placeholder="Auto-generated if blank" {...register('sku')} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setValue('sku', generateSku())}
              >
                Auto
              </Button>
            </div>
          </Field>
          <Field
            label={isBook ? 'ISBN' : 'Barcode'}
            error={errors.barcode?.message}
            optional
          >
            <div className="flex gap-2">
              <Input
                placeholder={isBook ? '978-…' : 'Scan or type'}
                {...register('barcode')}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setScannerOpen(true)}
                disabled={lookingUp}
              >
                {lookingUp ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ScanLine className="h-3.5 w-3.5" />
                )}
                Scan
              </Button>
              {!isBook && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleUpcLookup}
                  disabled={lookingUp}
                  title="Fetch product info from UPC"
                >
                  {lookingUp ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    'Lookup'
                  )}
                </Button>
              )}
            </div>
          </Field>
        </div>
        {!isBook && (
          <Field
            label="Model number"
            error={errors.modelNumber?.message}
            optional
          >
            <Input
              placeholder="e.g. MX432LL/A (manufacturer's per-SKU code)"
              {...register('modelNumber')}
            />
          </Field>
        )}
        {isBook && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Author" optional>
              <Input
                placeholder="e.g. Toni Morrison"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </Field>
            <div className="space-y-1.5">
              <Label>
                Grade level
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Select
                value={grade || '__none'}
                onValueChange={(v) => setGrade(v === '__none' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">—</SelectItem>
                  {GRADES.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g === 'K'
                        ? 'Kindergarten'
                        : /^\d{1,2}$/.test(g)
                          ? `Grade ${g}`
                          : g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <Field label="Description" error={errors.description?.message} optional>
          <Textarea rows={3} {...register('description')} />
        </Field>
      </Section>

      <Section title="Classification">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Item type</Label>
            <Select
              value={watch('itemType') ?? 'product'}
              onValueChange={(v) =>
                setValue('itemType', v as 'product' | 'book' | 'asset' | 'consumable', {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="product">Product</SelectItem>
                <SelectItem value="book">Book</SelectItem>
                <SelectItem value="asset">Asset</SelectItem>
                <SelectItem value="consumable">Consumable</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-[11px]">
              Books appear under the Books tab; products under Items.
            </p>
          </div>
          <SelectField
            label="Category"
            value={watch('categoryId') ?? ''}
            onChange={(v) => setValue('categoryId', v || null)}
            options={categories}
            placeholder="Uncategorized"
            optional
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Supplier"
            value={watch('supplierId') ?? ''}
            onChange={(v) => setValue('supplierId', v || null)}
            options={suppliers}
            placeholder="None"
            optional
          />
          {(() => {
            const selectedCategory = categories.find(
              (c) => c.id === watch('categoryId'),
            );
            const categorySupportsSizes = Boolean(
              selectedCategory?.supports_sizes,
            );
            // Hide while editing — variants only apply at create-time. Each
            // existing variant edits as a normal single row.
            if (!categorySupportsSizes || isEdit) return <div />;
            return (
              <Field label="Sizes" optional>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_SIZES.map((s) => {
                    const picked = selectedSizes.some((x) => x.size === s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={picked}
                        onClick={() =>
                          setSelectedSizes((prev) =>
                            picked
                              ? prev.filter((x) => x.size !== s)
                              : [...prev, { size: s, quantity: 0 }],
                          )
                        }
                        className={cn(
                          'rounded border border-border px-2 py-1 text-xs transition-colors',
                          picked
                            ? 'bg-foreground text-background'
                            : 'hover:bg-muted',
                        )}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
                {selectedSizes.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {selectedSizes.map((entry, i) => (
                      <div key={entry.size} className="flex items-center gap-2">
                        <span className="w-10 text-xs font-medium">{entry.size}</span>
                        <Input
                          type="number"
                          min={0}
                          value={entry.quantity}
                          onChange={(e) =>
                            setSelectedSizes((prev) => {
                              const next = [...prev];
                              next[i] = {
                                ...entry,
                                quantity: Number(e.target.value) || 0,
                              };
                              return next;
                            })
                          }
                          className="h-8 w-24"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </Field>
            );
          })()}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Primary location"
            value={watch('primaryLocationId') ?? ''}
            onChange={(v) => setValue('primaryLocationId', v || null)}
            options={locations}
            placeholder="None"
            optional
          />
          {isBook ? (
            <Field label="Bin / shelf" optional>
              <Input placeholder="A-12, Shelf 3…" {...register('binLocation')} />
            </Field>
          ) : (
            <div />
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Rack number" optional>
            <Input
              placeholder="38"
              inputMode="numeric"
              value={rackNumber}
              onChange={(e) => setRackNumber(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
          <Field label="Rack row" optional>
            <Input
              placeholder="A"
              maxLength={4}
              value={rackRow}
              onChange={(e) =>
                setRackRow(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
              }
            />
          </Field>
        </div>
        {isBook && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>
                  Crate color
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={crateColor || '__none'}
                  onValueChange={(v) => setCrateColor(v === '__none' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No crate" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No crate</SelectItem>
                    {CRATE_COLORS.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="border-border inline-block h-3 w-3 rounded-full border"
                            style={{ backgroundColor: c.hex }}
                          />
                          {c.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>
                  Crate number
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  placeholder="e.g. 12"
                  inputMode="numeric"
                  value={crateNumber}
                  onChange={(e) => setCrateNumber(e.target.value)}
                />
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              A crate number is enough — the color is an optional label you can add
              later.
            </p>
          </>
        )}
      </Section>

      {customFieldDefs.some((d) => !d.archived) && (
        <Section title="Additional fields">
          <CustomFieldsInputs
            definitions={customFieldDefs}
            values={customFieldValues}
            onChange={setCustomFieldValues}
            disabled={isSubmitting}
          />
        </Section>
      )}

      <Section title={`${warehouseLabel} & ${charterLabel.toLowerCase()}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{warehouseLabel}</Label>
            {forcedWarehouseId ? (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {warehouses.find((w) => w.id === forcedWarehouseId)?.name ??
                  'Your assigned warehouse'}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  You can only create items at your assigned {warehouseLabel.toLowerCase()}.
                </p>
              </div>
            ) : (
              <Select
                value={watchedWarehouseId ?? ''}
                onValueChange={(v: string) => setValue('warehouseId', v || null)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={`Pick a ${warehouseLabel.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>
              {charterLabel}
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Select
              value={watchedCharterId ?? '__generic'}
              onValueChange={(v: string) =>
                setValue('charterId', v === '__generic' ? null : v)
              }
              disabled={!watchedWarehouseId}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    watchedWarehouseId
                      ? `Generic (any ${charterLabel.toLowerCase()})`
                      : `Pick a ${warehouseLabel.toLowerCase()} first`
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__generic">
                  Generic — any {charterLabel.toLowerCase()}
                </SelectItem>
                {allowedCharters.length === 0 && watchedWarehouseId ? (
                  <div className="px-3 py-2 text-[12px] text-muted-foreground">
                    No {charterLabel.toLowerCase()}s linked to this {warehouseLabel.toLowerCase()}
                    {' '}yet — admins can configure them in Admin → {warehouseLabel}s.
                  </div>
                ) : (
                  allowedCharters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Generic stock is shared across every {charterLabel.toLowerCase()} the {warehouseLabel.toLowerCase()} services.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Pricing & stock">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Unit cost" error={errors.unitCost?.message}>
            <Controller
              control={control}
              name="unitCost"
              render={({ field }) => (
                <BlankZeroNumberInput
                  step={0.01}
                  min={0}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder="0.00"
                />
              )}
            />
          </Field>
          <Field label="Retail price" error={errors.retailPrice?.message}>
            <Controller
              control={control}
              name="retailPrice"
              render={({ field }) => (
                <BlankZeroNumberInput
                  step={0.01}
                  min={0}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder="0.00"
                />
              )}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(() => {
            const selectedCategory = categories.find(
              (c) => c.id === watch('categoryId'),
            );
            const sizedFlowActive =
              !isEdit &&
              Boolean(selectedCategory?.supports_sizes) &&
              selectedSizes.length > 0;
            if (sizedFlowActive) {
              return (
                <Field label="On hand">
                  <p className="text-muted-foreground rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-2 text-[11.5px]">
                    Per-size qty is set above (Sizes).
                  </p>
                </Field>
              );
            }
            return (
              <Field label="On hand" error={errors.quantityOnHand?.message}>
                {isEdit ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      step="1"
                      {...register('quantityOnHand', { valueAsNumber: true })}
                      disabled
                      className="bg-muted/40 cursor-not-allowed opacity-70"
                      aria-readonly
                    />
                    {defaults?.id && (
                      <StockAdjustDialog
                        itemId={defaults.id}
                        itemName={defaults?.name ?? 'this item'}
                        currentQuantity={defaults?.quantityOnHand ?? 0}
                        trigger={
                          <Button type="button" variant="outline" size="sm" className="shrink-0">
                            Adjust
                          </Button>
                        }
                      />
                    )}
                  </div>
                ) : (
                  <Controller
                    control={control}
                    name="quantityOnHand"
                    render={({ field }) => (
                      <BlankZeroNumberInput
                        step={1}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="0"
                      />
                    )}
                  />
                )}
              </Field>
            );
          })()}
          <Field label="Reorder at" error={errors.reorderPoint?.message}>
            <Controller
              control={control}
              name="reorderPoint"
              render={({ field }) => (
                <BlankZeroNumberInput
                  step={1}
                  min={0}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder="0"
                />
              )}
            />
          </Field>
          <Field label="Reorder qty" error={errors.reorderQuantity?.message}>
            <Controller
              control={control}
              name="reorderQuantity"
              render={({ field }) => (
                <BlankZeroNumberInput
                  step={1}
                  min={0}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder="0"
                />
              )}
            />
          </Field>
        </div>
        <Field label="Unit of measure">
          <Input placeholder="unit, kg, lb, hr…" {...register('unitOfMeasure')} />
        </Field>
        {/*
          Tracking radio (None / Lot / Serial) removed per user request.
          trackingType still defaults to 'none' in the schema; advanced
          users can flip it via DB or a future admin form. The receive
          dialog's lot/serial capture only fires when an item has
          tracking_type set, so removing the field is safe.
        */}
        {lotSerialEnabled && (
          <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50/30 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
            <div className="space-y-1.5">
              <Label>Lot / serial tracking</Label>
              <Select
                value={watch('trackingType') ?? 'none'}
                onValueChange={(v) =>
                  setValue('trackingType', v as 'none' | 'lot' | 'serial', { shouldDirty: true })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="lot">Lot (expiry / FEFO)</SelectItem>
                  <SelectItem value="serial">Serial</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[11px]">
                Lot-tracked items capture lot numbers + expiry at receiving and appear in aging / recall reports.
              </p>
            </div>
            {watch('trackingType') === 'lot' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Shelf life (days)</Label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={watch('shelfLifeDays') ?? ''}
                    onChange={(e) =>
                      setValue('shelfLifeDays', e.target.value === '' ? null : Number(e.target.value), {
                        shouldDirty: true,
                      })
                    }
                    placeholder="e.g. 30"
                  />
                  <p className="text-muted-foreground text-[11px]">
                    Used to estimate expiry when a lot has no explicit date.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Expiry policy</Label>
                  <Select
                    value={watch('expiryPolicy') ?? 'warn'}
                    onValueChange={(v) =>
                      setValue('expiryPolicy', v as 'none' | 'warn' | 'block', { shouldDirty: true })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Track only</SelectItem>
                      <SelectItem value="warn">Warn (default)</SelectItem>
                      <SelectItem value="block">Block expired picks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}
        {isEdit && (
          <p className="text-xs text-muted-foreground">
            On hand is locked here so every change goes through a stock
            movement (audit trail + dashboard math depends on it). Click
            <span className="font-medium"> Adjust</span> next to the field
            to add or remove stock without leaving this page.
          </p>
        )}
      </Section>

      {tags.length > 0 && (
        <Section title="Tags">
          <p className="text-xs text-muted-foreground">
            Click any tag to apply or remove it. Tags stack on top of category
            and show up in inventory filters and the bulk actions toolbar.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => {
              const on = selectedTagIds.has(t.id);
              const swatch = t.color ?? '#94a3b8';
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTag(t.id)}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                    on
                      ? 'border-transparent text-white shadow-sm'
                      : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
                  )}
                  style={on ? { backgroundColor: swatch } : undefined}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-2 w-2 rounded-full',
                      on ? 'bg-white/80' : '',
                    )}
                    style={!on ? { backgroundColor: swatch } : undefined}
                  />
                  {t.name}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {(() => {
        if (!isEdit) return null;
        const selectedCategory = categories.find(
          (c) => c.id === watch('categoryId'),
        );
        if (!selectedCategory?.supports_sizes) return null;
        if (
          !defaults?.categoryId ||
          !defaults?.warehouseId
        )
          return null;
        return (
          <div className="flex items-center justify-between rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5 text-[12.5px]">
            <div>
              <p className="font-medium">Add sibling sizes from this item</p>
              <p className="text-muted-foreground text-[11.5px]">
                Copies supplier, category, warehouse, prices, and rack — you
                pick the sizes + per-size qty.
              </p>
            </div>
            <AddSizedVariantsButton
              source={{
                name: watch('name') ?? '',
                sku: (watch('sku') ?? null) || null,
                barcode: (watch('barcode') ?? null) || null,
                description: (watch('description') ?? null) || null,
                categoryId: watch('categoryId') as string,
                supplierId: watch('supplierId') ?? null,
                warehouseId: watch('warehouseId') as string,
                charterId: watch('charterId') ?? null,
                primaryLocationId: watch('primaryLocationId') ?? null,
                binLocation: watch('binLocation') ?? null,
                retailPrice: Number(watch('retailPrice') ?? 0),
                unitCost: Number(watch('unitCost') ?? 0),
                reorderPoint: Number(watch('reorderPoint') ?? 0),
                reorderQuantity: Number(watch('reorderQuantity') ?? 0),
                unitOfMeasure: watch('unitOfMeasure') ?? 'unit',
                itemType: (watch('itemType') ?? itemType) as
                  | 'product'
                  | 'book'
                  | 'asset'
                  | 'consumable',
              }}
            />
          </div>
        );
      })()}

      <div className="flex justify-end gap-2">
        {(onDone || returnHref) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (returnHref) {
                router.push(
                  resolveListReturnHref(
                    isBook ? '/dashboard/books' : '/dashboard/inventory',
                    returnHref,
                  ),
                );
              }
              onDone?.();
            }}
            disabled={isSubmitting || uploadingImages}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" variant="gradient" disabled={isSubmitting || uploadingImages}>
          {isSubmitting || uploadingImages ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadingImages ? 'Uploading photos…' : 'Saving…'}
            </>
          ) : isEdit ? (
            'Save changes'
          ) : staged.length > 0 ? (
            `Create item & upload ${staged.length} photo${staged.length === 1 ? '' : 's'}`
          ) : (
            'Create item'
          )}
        </Button>
      </div>
      {scannerOpen && (
        <IsbnScanner
          open={scannerOpen}
          onOpenChange={setScannerOpen}
          onDetected={handleIsbnDetected}
          mode={isBook ? 'isbn' : 'barcode'}
        />
      )}
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  error,
  optional,
  children,
}: {
  label: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {optional && (
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        )}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
  placeholder: string;
  optional?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {optional && (
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        )}
      </Label>
      <Select value={value || '__none'} onValueChange={(v: string) => onChange(v === '__none' ? '' : v)}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
