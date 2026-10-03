// Pure catalog/cart logic for the storefront order page. No React —
// everything in here is unit-testable with plain data. The UI layers
// (cards / toolbar / cart) call these so filtering, sorting, status
// derivation, and totals behave identically everywhere.
//
// ═══ THE CATALOG LOGIC LIVES IN CORE ═══
//
// Everything that was above the delivery-request section of this file (the
// status derivation, the filter/sort pipeline, the stepper clamp, the qty map,
// the success reference line) moved, unchanged, to @stockpilot/core
// (orders/storefront/logic.ts) so the phone shares it (phone ordering PO-1).
// Every name is re-exported here as before, so the web's call sites and tests
// do not change. Core names the status type `StorefrontItemStatus` (core's
// `ItemStatus` is the inventory status); it is `ItemStatus` here, as always.

export {
  AVAILABILITY_LABELS,
  availabilityLabel,
  availableOf,
  buildQtyMap,
  clampQty,
  filterCatalog,
  glyphFor,
  isBrowsingAll,
  SORT_OPTIONS,
  sortCatalog,
  statusOf,
  successRefLine,
  type AvailabilityFilter,
  type CatalogFilterInput,
  type CategoryFilter,
  type SortKey,
  type StorefrontItemStatus as ItemStatus,
  type ViewMode,
} from '@stockpilot/core';

/**
 * Cart totals — moved to `@stockpilot/core` (orders/cart-totals.ts) 2026-08-13
 * and re-exported here so the six web call sites keep importing it from this
 * module unchanged.
 *
 * It moved rather than being duplicated because the delivery-request builder,
 * now in core, prints `lineCount`/`unitCount` in the email body's ITEMS
 * heading while these same numbers render on the cart badge the requester
 * checks before submitting. If the two ever disagreed, the recipient and the
 * requester would be reading different orders. One function makes that
 * impossible rather than merely unlikely (recurring pattern #26).
 */
export { cartTotals, type CartTotals } from '@stockpilot/core';

/* ---- delivery-request assistant ------------------------------------------ */

/**
 * THE BUILDER MOVED TO CORE (2026-08-13). Everything below this line is a
 * re-export shim over `packages/core/src/orders/delivery-request.ts` — the same
 * shape this file already used for `OUTLOOK_COMPOSE_BASE` and
 * `DRAFT_URL_LIMIT` after the 2026-08-05 transport extraction.
 *
 * WHY IT MOVED. Both surfaces have to send the SAME email. Web has composed
 * delivery requests since 2026-08-01; the mobile order screen is about to. Two
 * copies of a message builder drift — recurring pattern #26, and the exact
 * failure class this codebase has been fighting all week. Drift here is
 * especially expensive because it is SILENT: a request that reaches DC4 with a
 * stale row format, a shortened body that no longer discloses what it dropped,
 * or without the mandatory CC still looks sent to the employee who sent it.
 * Mobile cannot import from `apps/web`; its only workspace dependency is
 * `@stockpilot/core`. So the message is defined there, once.
 *
 * WHAT MOVED: `toPlainTextLine`, `formatSiteAddressLines`, the draft/input/
 * prepared types, the shortened-disclosure copy, `condensedNoticeText`, the
 * three URL builders, `buildDeliveryRequestDraft` and `prepareDeliveryRequest`
 * — verbatim, plus `cartTotals` (six web UI call sites keep importing it from
 * here) and the four `@/lib/timezone` formatters. The tenant-verified
 * transport history — `mailtouri` and not `cc=`, outlook.cloud.microsoft and
 * not outlook.office.com, why the name-addr chip is OWA-only — moved with the
 * code it documents and is now in that module.
 *
 * WHAT STAYED OUT OF THE DELIVERY MODULE: the catalog filter/sort pipeline,
 * the status derivation and `successRefLine` are storefront concerns with no
 * delivery involvement, so they were not moved into core's delivery-request
 * module. (Phone ordering PO-1 later moved them to core's own storefront
 * module, orders/storefront/logic.ts; this file re-exports them, see the top.)
 * `CatalogItem` stays in `../v2/types` — the whole point of the builder's
 * narrowed item type is that it cannot reach `price` or any other staff-only
 * field, and widening core's view of an item would undo that.
 *
 * NOTHING IN WEB CHANGED SHAPE. Every symbol this file exported before the
 * move it still exports, under the same name and the same signature, so every
 * import site and every test compiles and passes unedited. Byte-identical
 * output was verified by driving both builders over an 11-line order with a
 * recorded requester and notes, dumping every rung of the ladder, both URLs,
 * the clipboard text and their lengths, and diffing before against after.
 */

import {
  buildDeliveryRequestDraft as coreBuildDeliveryRequestDraft,
  prepareDeliveryRequest as corePrepareDeliveryRequest,
  type DeliveryRequestInput as CoreDeliveryRequestInput,
  type DeliveryRequestRecipients,
  type PreparedDeliveryRequest,
} from '@stockpilot/core';

export {
  condensedNoticeText,
  formatSiteAddressLines,
  toPlainTextLine,
  type DeliveryRequestDraft,
  type PreparedDeliveryRequest,
} from '@stockpilot/core';

/**
 * Conservative ceiling for a compose link, in characters, and the OWA compose
 * host. Outlook Web and mailto: both carry the body in the query string;
 * practical limits land around 2,000 and Outlook desktop truncates SILENTLY,
 * which is the dangerous part. 1,800 leaves headroom for the tenant's own
 * redirect wrapper. Both live in core with the transports they constrain.
 */
export { DRAFT_URL_LIMIT, OUTLOOK_COMPOSE_BASE } from '@stockpilot/core';

/**
 * The three transports, under the names this file has always exported them by.
 *
 * They now read the recipients OFF THE DRAFT rather than closing over
 * `DELIVERY_REQUEST_EMAIL_NAMES`, which is why the draft carries `toName` and
 * `ccName`: a draft is self-contained, so a URL can never be built against
 * different recipients than the ones the preview showed the employee.
 */
export {
  buildDeliveryRequestOutlookUrl as buildOutlookComposeUrl,
  buildDeliveryRequestMailtoUrl as buildMailtoUrl,
  buildDeliveryRequestClipboardText as buildClipboardText,
} from '@stockpilot/core';

/**
 * WEB'S RECIPIENTS ARE NOW AN EXPLICIT PARAMETER — the per-org routing seam
 * (2026-08-16), replacing the module constant `WEB_DELIVERY_RECIPIENTS` that
 * pinned every org's delivery mail to the compiled L4L pair.
 *
 * THE CC IS STILL THE ACCEPTANCE GATE, guaranteed one level up now: the
 * parameter's type is the BRANDED `DeliveryRequestRecipients`, producible
 * only by core's validating factory — so the value that arrives here came
 * from either the org row (parsed by `parseOrgEmailRouting`, re-branded at
 * the surface's seam) or the compiled constant (the code-before-migration
 * fallback). A caller cannot type an object literal, spread-modify a copy,
 * or pass a maintenance recipients value; core additionally re-validates
 * both addresses at draft time and throws on anything that is not exactly
 * one plain mailbox. Untyped client data (URL params, order notes, site
 * names) still cannot reach the recipient fields — they do not construct
 * branded values.
 */

/**
 * Everything the draft builder is allowed to see, MINUS the recipients — those
 * travel as their own branded argument. Keeping them off this type is what
 * lets `storefront-overlays.tsx`, `send-delivery-request-button.tsx` and both
 * test suites construct an input exactly as they did before the move.
 */
export type DeliveryRequestInput = Omit<CoreDeliveryRequestInput, 'recipients'>;

/** Build the delivery-request draft. The full contract is on the core module. */
export function buildDeliveryRequestDraft(
  input: DeliveryRequestInput,
  recipients: DeliveryRequestRecipients,
  opts: { condensed?: boolean; maxRows?: number } = {},
) {
  return coreBuildDeliveryRequestDraft({ ...input, recipients }, opts);
}

/**
 * Build every transport, choosing how much of the item list fits. See core.
 *
 * NO `transport` OPTION, deliberately. Web opens the https OWA url
 * (`window.open` on `prepared.outlookUrl`), so it must keep fitting rows
 * against that url — which is core's default, `outlook-web`. Mobile passes
 * `outlook-native` when it has PROVED the native app will take the link; a
 * browser can never prove that, and asking for the shorter budget here would
 * fit rows against a url this surface does not open and truncate the body
 * silently in the one it does. Output for the compiled recipients is
 * byte-identical to before the recipients parameter existed, pinned by
 * `prepareDeliveryRequest — the ladder, measured end to end` in
 * storefront-logic.test.ts.
 */
export function prepareDeliveryRequest(
  input: DeliveryRequestInput,
  recipients: DeliveryRequestRecipients,
): PreparedDeliveryRequest {
  return corePrepareDeliveryRequest({ ...input, recipients });
}
