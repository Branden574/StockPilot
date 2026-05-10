/**
 * Shared audit-event formatting helpers used by the global audit log
 * page and the per-entity timeline component.
 *
 * Event names follow the dotted convention from server/services/audit.ts
 * (e.g. `inventory.item.created`, `stock.adjusted`). We render them as
 * "Subject · Action" where the subject is the leading domain words and
 * the action is the trailing verb.
 */

const SUBJECT_OVERRIDES: Record<string, string> = {
  user: 'User',
  inventory: 'Inventory',
  stock: 'Stock',
  warehouse: 'Warehouse',
  warehouse_charters: 'Warehouse charters',
  charter: 'Charter',
  report: 'Report',
  po_import: 'PO import',
  vendor_item_mapping: 'Vendor item mapping',
  idempotency: 'Idempotency',
  uom_conversion: 'UoM conversion',
  item: 'Item',
  lot: 'Lot',
  serial: 'Serial',
  cycle_count: 'Cycle count',
  bundle: 'Bundle',
  order_request: 'Order request',
};

const ENTITY_OVERRIDES: Record<string, string> = {
  inventory_item: 'Inventory item',
  purchase_order: 'Purchase order',
  cycle_count: 'Cycle count',
  order_request: 'Order request',
  vendor_item_mapping: 'Vendor item mapping',
  uom_conversion: 'UoM conversion',
  warehouse_charters: 'Warehouse charters',
};

function titleCase(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Turns `inventory.item.created` into `Inventory item · Created`.
 * Falls back gracefully for unknown shapes (no dot ⇒ title-cased whole).
 */
export function formatAuditEvent(event: string): string {
  if (!event) return '—';
  const parts = event.split('.');
  if (parts.length === 1) return titleCase(parts[0] ?? event);
  const action = parts[parts.length - 1] ?? '';
  const subjectParts = parts.slice(0, -1);
  const head = subjectParts[0] ?? '';
  const subjectFromOverride = SUBJECT_OVERRIDES[subjectParts.join('.')]
    ?? SUBJECT_OVERRIDES[head];
  const subject = subjectFromOverride
    ? subjectParts.length > 1 && !SUBJECT_OVERRIDES[subjectParts.join('.')]
      ? `${subjectFromOverride} ${titleCase(subjectParts.slice(1).join(' '))}`
      : subjectFromOverride
    : titleCase(subjectParts.join(' '));
  return `${subject} · ${titleCase(action)}`;
}

/** Friendly label for an entity_type stored in audit metadata. */
export function formatEntityType(entityType: string | null | undefined): string {
  if (!entityType) return '';
  return ENTITY_OVERRIDES[entityType] ?? titleCase(entityType);
}

/** First 8 chars of a UUID — enough to identify a row in an admin context. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.length > 8 ? id.slice(0, 8) : id;
}
