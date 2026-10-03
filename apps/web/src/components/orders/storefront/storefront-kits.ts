// Kits on the New order page: pure logic, no React.
//
// ═══ THE KIT LOGIC LIVES IN CORE ═══
//
// This whole module moved, unchanged, to @stockpilot/core
// (orders/storefront/kits.ts) so the phone adds kits by the same rules as this
// page (phone ordering PO-1). The rules (one component counts every rack of
// its SKU, where a kit's units go, raising never lowers a line changed by hand,
// all or nothing) are documented there, with the code. Every name this module
// exported is re-exported here, so the web's call sites, the kits loader and
// the tests do not change.

export {
  allocateUnits,
  componentAvailable,
  componentItem,
  componentRows,
  filterKits,
  kitAvailability,
  kitCategoryKeys,
  kitsForAudit,
  kitsInCart,
  kitStatus,
  maxKits,
  planKitChange,
  releaseUnits,
  shortComponentNames,
  type KitAvailability,
  type KitComponent,
  type KitLineChange,
  type KitOffer,
  type KitPlan,
  type KitsResult,
} from '@stockpilot/core';
