/**
 * COMPATIBILITY SHIM — the implementation now lives in
 * `packages/core/src/inventory/book-storage.ts`.
 *
 * It moved because it is 100% pure (its only dependency was the CRATE_COLORS
 * registry, already in core) and BOTH surfaces read these `custom_fields` keys:
 * web renders them on the item detail / exports / pick + count sheets, and
 * mobile reads them on the books tab and item screen. A helper that two apps
 * must agree on belongs in the shared package, not in one of them.
 *
 * This file stays so the ~8 existing `@/lib/book-storage` importers keep
 * working — the same shim pattern `crate-colors.ts` used when it moved. NEW
 * code should import from `@stockpilot/core` directly.
 */
export {
  CRATE_COLORS,
  formatCrateLabel,
  formatCrateLocationName,
  formatGrade,
  getCrateColor,
  GRADES,
  readBookStorage,
  readItemRack,
  type BookStorageInfo,
  type CrateColorSlug,
  type Grade,
} from '@stockpilot/core';
