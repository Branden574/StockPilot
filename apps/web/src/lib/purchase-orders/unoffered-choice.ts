/**
 * A value a purchase order or recurring template holds that its form's
 * select cannot offer, and what the form says about it.
 *
 * THE DEFECT (small fixes slice 8, items A, B, D; the class #334 closed for
 * Make recurring). A Radix select shows a value no option has as a blank box,
 * while the form keeps the value and the save sends it. So editing a draft
 * purchase order whose destination is a staging area or a deleted location,
 * a template whose destination was deleted after it was saved, or either one
 * whose supplier was archived, showed blank and saved the hidden value again.
 *
 * THE RULE, as #334 set it for Make recurring: the form never keeps a value it
 * does not offer. It opens with none chosen and a note under the select
 * naming what was there and why it cannot be picked; choosing an option
 * clears the note. The page reads the name and state on the server, in the
 * caller's organization; when it could not, the note says the same without a
 * name.
 *
 * Plain module (no 'use client'): the client forms and their tests import it.
 */

/** A destination location its form does not offer, as the page read it. */
export interface UnofferedDestination {
  /** The location's name; null when it could not be read or is blank. */
  name: string | null;
  /**
   * Why the form cannot offer it: deleted; not a site (a staging area or
   * Unplaced, a rack, crate, area, shelf or bin); a site linked to no
   * warehouse (the save refuses it); or not known (the read failed).
   */
  why: 'deleted' | 'not_a_site' | 'no_warehouse' | 'unknown';
}

/** A supplier its form does not offer, as the page read it. */
export interface UnofferedSupplier {
  /** The supplier's name; null when it could not be read or is blank. */
  name: string | null;
  /** Archived (suppliers.deleted_at), or not known (the read failed). */
  why: 'archived' | 'unknown';
}

/** Whose value it is: the words name it. */
export type UnofferedOwner = 'purchase_order' | 'template';

function quoted(name: string | null): string | null {
  const n = (name ?? '').trim();
  return n ? `"${n}"` : null;
}

/**
 * The note under Destination. A purchase order "goes to" its destination; a
 * template "has" one.
 */
export function unofferedDestinationNote(
  owner: UnofferedOwner,
  destination: UnofferedDestination | null | undefined,
): string {
  const name = quoted(destination?.name ?? null);
  const why = destination?.why ?? 'unknown';
  if (owner === 'purchase_order') {
    if (why === 'deleted') {
      return name
        ? `This purchase order goes to ${name}, which was deleted, so choose a destination.`
        : 'This purchase order goes to a location that was deleted, so choose a destination.';
    }
    if (why === 'no_warehouse' && name) {
      return `This purchase order goes to ${name}, which isn't linked to a warehouse, so choose a destination.`;
    }
    return name
      ? `This purchase order goes to ${name}, which is not a site you can pick here, so choose a destination.`
      : "This purchase order goes to a location you can't pick here, so choose a destination.";
  }
  if (why === 'deleted') {
    return name
      ? `This template's destination, ${name}, was deleted, so choose a destination.`
      : "This template's destination was deleted, so choose a destination.";
  }
  if (why === 'no_warehouse' && name) {
    return `This template's destination, ${name}, isn't linked to a warehouse, so choose a destination.`;
  }
  return name
    ? `This template's destination, ${name}, is not a site you can pick here, so choose a destination.`
    : "This template's destination is a location you can't pick here, so choose a destination.";
}

/** The note under Supplier. */
export function unofferedSupplierNote(
  owner: UnofferedOwner,
  supplier: UnofferedSupplier | null | undefined,
): string {
  const whose = owner === 'purchase_order' ? "This purchase order's supplier" : "This template's supplier";
  const name = quoted(supplier?.name ?? null);
  if (supplier?.why === 'archived') {
    return name
      ? `${whose}, ${name}, was archived, so choose a supplier.`
      : `${whose} was archived, so choose a supplier.`;
  }
  return name
    ? `${whose}, ${name}, is not a supplier you can pick here, so choose a supplier.`
    : `${whose} is not one you can pick here, so choose a supplier.`;
}

/**
 * What a location row's state makes it for a destination select that offers
 * sites linked to a warehouse (the purchase order and recurring forms).
 * `isSite` is core's isSiteLocation for the row.
 */
export function unofferedDestinationFrom(
  row: { name?: string | null; deleted_at?: string | null; warehouse_id?: string | null } | null | undefined,
  isSite: boolean,
): UnofferedDestination {
  if (!row) return { name: null, why: 'unknown' };
  const name = (row.name ?? '').trim() || null;
  if (row.deleted_at) return { name, why: 'deleted' };
  if (!isSite) return { name, why: 'not_a_site' };
  if (!row.warehouse_id) return { name, why: 'no_warehouse' };
  return { name, why: 'unknown' };
}
