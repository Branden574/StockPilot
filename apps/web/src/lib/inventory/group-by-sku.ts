// Moved to @stockpilot/core so the mobile Items list can share the exact same
// same-SKU placement collapse the web table uses (web/mobile parity). This
// thin re-export keeps every existing web importer (inventory-table.tsx,
// po-imports/*) unchanged — same names, same types, same module path.
export { groupPlacementsBySku, rollupStatus, type PlacementRow, type SkuGroup } from '@stockpilot/core';
