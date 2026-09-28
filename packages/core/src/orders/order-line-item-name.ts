/**
 * The name an order line shows for its item, on the web order page and the
 * phone order screen, so both say the same thing about the same row.
 *
 * A line whose item row came back empty used to read "Deleted item" on the
 * web and "Unknown item" on the phone, and neither was true. A line's item
 * cannot be deleted: order_request_lines.item_id is ON DELETE RESTRICT, and a
 * soft-deleted item (deleted_at set) is still readable and keeps its name. The
 * item embed is empty when the reader's inventory_items_select policy hides
 * the item: a member scoped to other warehouses, or one with no warehouse
 * yet. That line's readiness says the same in its own words ("This item isn't
 * visible to you, so its stock can't be checked.").
 */

export const ORDER_LINE_HIDDEN_ITEM_NAME = "An item you can't see";

/**
 * The line's item as the reader's query embedded it: null or undefined when
 * the reader's access hid it. order_request_lines.item_id and
 * inventory_items.name are both NOT NULL, so a name is missing only when the
 * item is (a client's row type may still say `string | null`).
 */
export function orderLineItemName(item: { name?: string | null } | null | undefined): string {
  return item?.name ?? ORDER_LINE_HIDDEN_ITEM_NAME;
}
