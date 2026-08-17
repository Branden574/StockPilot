'use client';

import {
  bookCrateAcknowledgementsMatch,
  bookRackAcknowledgementsMatch,
  describeBookCrateChange,
  describeBookCrateConflict,
  describeNewRackPlacement,
  describeRackChange,
  hasRackPosition,
  parseBookCrateChangeDetail,
  parseBookRackChangeDetail,
  toBookCrateAcknowledgement,
  toBookRackAcknowledgement,
  type BookCrateAcknowledgedChange,
  type BookRackAcknowledgedChange,
  type BookStorageInfo,
} from '@stockpilot/core';
import { Loader2, PackageCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  BookDestinationFields,
  CurrentStorageSummary,
  DestinationCrateNote,
} from '@/components/inventory/crate-fields';
import {
  PlacementConfirmDialog,
  type PlacementConfirmContent,
} from '@/components/inventory/placement-confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import type { DestinationOption } from '@/lib/locations/destination-option';
import {
  destinationCrate,
  destinationFromFields,
  destinationIsRecordedStorage,
  destinationLabel,
  destinationPhrase,
  destinationPosition,
  EMPTY_DESTINATION_FIELDS,
  fieldsFromOption,
  isCrateChoice,
  newDestinationProblem,
  newDestinationReady,
  planNewDestination,
  seedDestinationFields,
  type ChosenDestination,
  type DestinationFields,
} from '@/lib/locations/placement-destination';
import { placeStockAction } from '@/server/actions/inventory';

/** Non-books only: the dropdown entry that opens the inline rack form. */
const NEW_RACK_SENTINEL = '__new__';

type ActionDestination = Parameters<typeof placeStockAction>[0]['destination'];

interface PlaceFromStagingDialogProps {
  itemId: string;
  itemName: string;
  itemType: string;
  /** The not-yet-placed holding location to move stock OUT of (staging or unplaced). */
  sourceLocationId: string;
  /** Drives the "From" label + copy. 'unplaced' = on-hand stock that was never racked. */
  sourceKind: 'staging' | 'unplaced';
  warehouseId: string;
  /** Warehouse display name — shown in the new-rack confirmation copy. */
  warehouseName?: string;
  /** Quantity sitting in the source holding (the placement ceiling). */
  availableQuantity: number;
  destinations: DestinationOption[];
  /**
   * A BOOK's recorded rack/crate SUMMARY, or null for a non-book. Shown as
   * context and used to PREDICT the server's confirmation gate locally, so the
   * question is asked before the submit rather than after it. Never authority:
   * the server re-reads the item before it writes.
   */
  bookStorage?: BookStorageInfo | null;
  /**
   * Whether this user may CREATE a rack/crate row (`locations:manage`; RLS
   * `locations_insert` requires it, migration 0212). The server is the
   * authority; this only lets the dialog say so BEFORE the submit when the four
   * fields name a row that does not exist yet — for a label-only crate that is
   * the default path, and a bare server refusal there would read as "put-away
   * is broken". Defaults to true so callers that predate the prop keep today's
   * behaviour (offer, and let the server refuse).
   */
  canManageLocations?: boolean;
  trigger?: React.ReactNode;
}

export function PlaceFromStagingDialog({
  itemId,
  itemName,
  itemType,
  sourceLocationId,
  sourceKind,
  warehouseId,
  warehouseName,
  availableQuantity,
  destinations,
  bookStorage,
  canManageLocations = true,
  trigger,
}: PlaceFromStagingDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const sourceLabel = sourceKind === 'unplaced' ? 'Unplaced' : 'Staging';

  const [destId, setDestId] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState(String(availableQuantity));
  const [notes, setNotes] = React.useState('');

  // ═══ THE FOUR FIELDS ARE THE DESTINATION (books) — Maus I, 2026-08-17 ═══
  //
  // For a BOOK these four boxes are the primary "To" input: always visible,
  // PRE-FILLED from the book's recorded storage on open, and the primary action
  // places INTO exactly that crate on that rack (the server resolves-or-creates
  // the row by name). They used to live behind a "+ New rack / crate" dropdown
  // entry and a Rack|Crate toggle, so for a label-only crate — most crates in
  // this warehouse — the crate the dialog had just said the book was in was not
  // in the list and could only be re-typed from scratch. The reachable choice
  // was the bare rack, which clears the crate; the gate asked; the operator had
  // nowhere else to go. See placement-destination.ts for the pure rules.
  //
  // For a NON-BOOK the older shape stays: the dropdown, "+ New rack / crate",
  // and the rack pair inline. Nothing about a non-book was wrong.
  const [fields, setFields] = React.useState<DestinationFields>(EMPTY_DESTINATION_FIELDS);
  const { rackNumber, rackRow, crateColor, crateNumber } = fields;
  const setField = (key: keyof DestinationFields) => (value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));
  /** A recorded crate colour the Select cannot show (not in CRATE_COLORS). */
  const [unknownCrateColor, setUnknownCrateColor] = React.useState<string | null>(null);

  const [submitting, setSubmitting] = React.useState(false);
  // ONE pending confirmation, whatever it has to ask about — a genuinely new
  // rack/crate (the 2026-07-23 typo guard), an overwrite of the book's
  // recorded crate (the server's gate, predicted locally), or both at once.
  // Null on the common path, which stays exactly as fast as it was.
  const [pendingConfirm, setPendingConfirm] = React.useState<{
    content: PlacementConfirmContent;
    destination: ActionDestination;
    /**
     * EXACTLY the crate changes this dialog put on screen — item id plus a
     * fingerprint of the crate it named. Never a blanket "yes": if the row
     * changed underneath us since it rendered, the fingerprint no longer
     * matches and the server refuses, re-asking with current truth.
     */
    acknowledged: BookCrateAcknowledgedChange[];
    /**
     * The RACK erasures this dialog put on screen, fingerprinted over the rack
     * pair. Always the SERVER's lines: this component holds a render-time
     * snapshot and no holdings, so it can never tell a full move (which clears
     * the pair) from a split (which does not) — see `deferToServer` below.
     */
    acknowledgedRacks: BookRackAcknowledgedChange[];
  } | null>(null);
  // Server failures render inline (persistent) as well as via toast — same
  // rationale as StockTransferDialog: a toast alone auto-dismisses outside
  // the modal and a rejected submit can read as "nothing happened".
  const [serverError, setServerError] = React.useState<string | null>(null);

  const isBook = itemType === 'book';
  const isNew = !isBook && destId === NEW_RACK_SENTINEL;
  const selectedDestination = destinations.find((d) => d.id === destId) ?? null;

  // Reset form state whenever the dialog opens — and for a BOOK, seed the four
  // fields from its recorded storage. "Where it already lives" is the default
  // destination; the operator edits away from it, never toward it.
  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset all fields when dialog opens */
    setDestId('');
    setQuantity(String(availableQuantity));
    setNotes('');
    const seeded = seedDestinationFields(isBook ? bookStorage : null);
    setFields(seeded.fields);
    setUnknownCrateColor(seeded.unknownCrateColor);
    setServerError(null);
    setPendingConfirm(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any edit to the destination/quantity invalidates a pending confirmation —
  // its copy names a specific label and count, so it must not outlive the inputs
  // it described. Cheap to recompute: hitting Place re-derives it.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale confirmation on edit
    setPendingConfirm(null);
  }, [destId, rackNumber, rackRow, crateColor, crateNumber, quantity]);

  const qtyNum = Number.parseInt(quantity, 10);
  const qtyValid = Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= availableQuantity;

  /**
   * The existing-location dropdown, for a BOOK, is a shortcut that FILLS the
   * four fields from the row's own columns. Picking a bare rack blanks the
   * crate — that IS choosing "no crate", and the gate will say so before the
   * write. The selection is remembered so that, while the boxes still equal
   * the row, the request goes by id (nothing to create).
   */
  function pickExisting(id: string) {
    setDestId(id);
    if (!isBook) return;
    const option = destinations.find((d) => d.id === id);
    if (!option) return;
    setFields(fieldsFromOption(option));
    setUnknownCrateColor(null);
  }

  /** The destination as chosen in this form — the input to every derivation.
   *
   *  BOOKS: the four fields decide (`destinationFromFields`) — an existing row
   *  by id while the boxes still equal it, otherwise a crate on the typed
   *  position (any crate box filled) or a bare rack. NON-BOOKS: the dropdown,
   *  or the inline rack pair behind "+ New rack / crate". */
  function chosenDestination(): ChosenDestination | null {
    if (isBook) return destinationFromFields(fields, selectedDestination);
    if (isNew) return { mode: 'new-rack', rackNumber, rackRow };
    return selectedDestination ? { mode: 'existing', option: selectedDestination } : null;
  }

  // THE READINESS GATE IS THE PLANNER. It used to be a hand-rolled field check
  // (`crateNumber` non-empty on the crate branch) and it drifted from
  // planNewLocation inside the very commit that added the crate's rack pair:
  // crate 13 plus a "Row" with no "On rack" number satisfied it, the planner
  // refused the pair, and this dialog offered "Create new crate ?". Delegating
  // is what the phone has always done (newLocationReady in
  // apps/mobile/src/lib/move-stock-form.ts).
  const chosen = chosenDestination();
  const newReady = chosen !== null && newDestinationReady(chosen);
  // Would this destination have to be MINTED? Only a caller with
  // `locations:manage` can do that (RLS refuses everyone else), so say so here
  // instead of letting the default path for a label-only crate die on a
  // server refusal. Judged by the same label the server resolves by, so an
  // existing "Red #4 on rack 38-B" is correctly not a mint.
  const plannedLabel = chosen && chosen.mode !== 'existing' ? destinationLabel(chosen) : '';
  const needsMint =
    plannedLabel.length > 0 &&
    !destinations.some((d) => d.name.trim().toLowerCase() === plannedLabel.toLowerCase());
  const cannotMint = needsMint && !canManageLocations;
  // The planner's OWN sentence, rendered inline beside the fields it is about
  // — or, when the fields are fine but the row would need creating by someone
  // who may not, that.
  const newProblem =
    chosen !== null
      ? (newDestinationProblem(chosen) ??
        (cannotMint
          ? `${plannedLabel} does not exist yet, and creating racks or crates needs the Manage locations permission. Pick an existing location, or ask a manager to create it.`
          : null))
      : null;
  // A BOOK submits whenever the four fields name a place the planner can name
  // (an existing row by id is always ready). A non-book: the dropdown, or a
  // ready inline rack.
  const canSubmit =
    !submitting &&
    qtyValid &&
    !cannotMint &&
    (isBook || isNew ? newReady : destId.length > 0);

  function toActionDestination(dest: ChosenDestination): ActionDestination {
    if (dest.mode === 'existing') return { existingLocationId: dest.option.id };
    if (dest.mode === 'new-crate') {
      // The rack pair travels WITH the crate when one was typed — it is the
      // crate's position, and the server names the row "Blue #13 on rack 38-B"
      // from exactly these fields. Omitted entirely when blank, so a crate on
      // no rack (production holds one) stays position-less and keeps matching
      // the existing "Blue #13" row.
      return {
        newRack: {
          warehouseId,
          crateNumber: dest.crateNumber.trim(),
          ...(dest.crateColor.trim() ? { crateColor: dest.crateColor.trim() } : {}),
          ...(dest.rackNumber.trim() ? { rackNumber: dest.rackNumber.trim() } : {}),
          ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
        },
      };
    }
    return {
      newRack: {
        warehouseId,
        rackNumber: dest.rackNumber.trim(),
        ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
      },
    };
  }

  /**
   * THE REMAINDER SENTENCE — true whatever the crate question turns out to be,
   * and therefore built OUTSIDE the branch that answers it.
   *
   * A partial placement leaves stock behind. That is a fact about the QUANTITY
   * alone: it does not depend on the book's crate, on the destination's rack,
   * or on which side of the wire ends up asking. It used to be assembled only
   * inside the local-prediction branch, so the moment the deferral started
   * returning before that branch the sentence vanished from every deferred
   * placement — a 10-of-18 put-away rendered the gate's crate panel and never
   * said the other 8 stay in staging. Derived here, rendered on BOTH paths.
   */
  function remainderNotice(): string | null {
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || qtyNum >= availableQuantity) return null;
    return `${availableQuantity - qtyNum} of ${availableQuantity} will stay in ${sourceLabel.toLowerCase()}, so this title will sit in more than one place.`;
  }

  // Run the placement. Split out from the gate below so the confirmation step
  // and the "Did you mean…" one-tap alternatives share ONE write path.
  async function place(
    destination: ActionDestination,
    opts: {
      acknowledged?: BookCrateAcknowledgedChange[];
      acknowledgedRacks?: BookRackAcknowledgedChange[];
      describe?: ChosenDestination;
    } = {},
  ) {
    setSubmitting(true);
    setServerError(null);
    const res = await placeStockAction({
      itemId,
      fromLocationId: sourceLocationId,
      quantity: qtyNum,
      notes: notes.trim() || undefined,
      destination,
      ...(opts.acknowledged && opts.acknowledged.length > 0
        ? { acknowledgedCrateChanges: opts.acknowledged }
        : {}),
      // ALWAYS SENT, EVEN EMPTY. Its presence is how this client declares it can
      // answer the rack question at all; omitting it tells the server "cannot
      // answer", and the server then preserves the rack rather than refusing —
      // correct for an old client, wrong for this one, which would silently stop
      // being asked. An empty array on the first request is exactly right: this
      // dialog cannot predict a rack erasure, so it asks to be told.
      acknowledgedRackChanges: opts.acknowledgedRacks ?? [],
    });
    setSubmitting(false);

    if (!res.ok) {
      // The server refused because this placement overwrites a crate a human
      // recorded. Our local prediction can be stale (the row may have changed
      // since the page rendered, and a non-Staging surface may not predict at
      // all), so the refusal is rendered from ITS payload and retried with an
      // acknowledgement built from THAT payload — the server's own reading of
      // the row, not our snapshot. Asked at most once more: a refusal that
      // survives an acknowledgement matching the server's own labels is a real
      // error, not a staleness loop.
      // TWO QUESTIONS, ONE PAYLOAD, ONE DIALOG. The crate half and the rack half
      // are separately fingerprinted and can arrive together or alone; a refusal
      // that says ANYTHING our last answer did not cover is re-asked, and one
      // that repeats what we already answered falls through to the plain error
      // rather than looping.
      const detail = parseBookCrateChangeDetail(res.error.details);
      const rackDetail = parseBookRackChangeDetail(res.error.details);
      const fresh = detail ? toBookCrateAcknowledgement(detail.items) : [];
      const freshRacks = rackDetail ? toBookRackAcknowledgement(rackDetail.items) : [];
      const unanswered =
        !bookCrateAcknowledgementsMatch(opts.acknowledged, fresh) ||
        !bookRackAcknowledgementsMatch(opts.acknowledgedRacks, freshRacks);
      if ((detail || rackDetail) && unanswered) {
        // ON THE DEFERRED PATH THIS IS THE ONLY PANEL THE OPERATOR SEES, so the
        // notices that are not part of the crate question have to ride here too
        // — otherwise deferring silently drops them. The remainder is the one
        // that applies: the quantity is unchanged by the refusal.
        const remainder = remainderNotice();
        setPendingConfirm({
          content: {
            // The rack-only refusal is the reported defect's own case: the crate
            // is IDENTICAL, so a title about changing the crate would name a
            // change that is not happening.
            title: detail ? 'Change this book’s crate?' : 'Clear this book’s rack?',
            message: res.error.message,
            ...(detail ? { crateItems: detail.items } : {}),
            ...(rackDetail ? { rackItems: rackDetail.items } : {}),
            ...(remainder ? { notices: [remainder] } : {}),
            confirmLabel: 'Continue placement',
          },
          destination,
          acknowledged: fresh,
          acknowledgedRacks: freshRacks,
        });
        return;
      }
      // Not a question we can ask again — close the confirmation and surface
      // the error on the form behind it. Leaving an already-answered
      // confirmation open would offer a Continue button that can only fail
      // again, with the inline error hidden underneath it.
      setPendingConfirm(null);
      setServerError(res.error.message);
      toast.error(res.error.message);
      return;
    }

    const unit = isBook ? (qtyNum === 1 ? 'copy' : 'copies') : qtyNum === 1 ? 'unit' : 'units';
    const where = opts.describe ? ` ${destinationPhrase(opts.describe)}` : '';
    toast.success(`Placed ${qtyNum} ${unit} of ${itemName}${where}.`);
    // The stock genuinely moved either way; these say the LABEL did not follow.
    // All three are reported the same way the Transfer dialog and the mobile
    // Move-stock modal report them — a plain success next to a summary naming a
    // crate the stock has left is the exact falsehood this whole gate exists to
    // prevent, so `crateSyncStale` warns here too rather than passing silently.
    if (res.data.crateSyncFailed) {
      toast.warning(
        `${itemName} was placed, but its crate label could not be updated — check the book’s details.`,
      );
    } else if (res.data.crateSyncStale) {
      toast.warning(
        `${itemName} was placed, but someone else changed its crate while it was moving — its label was left as they set it.`,
      );
    } else if (res.data.crateSyncUnplaced) {
      toast.warning(
        `${itemName} was placed, but none of its stock is in a rack or crate now — its crate label was left unchanged and may be wrong.`,
      );
    } else if (res.data.crateSyncSkipped) {
      toast.warning(
        `${itemName} now has stock in more than one location, so its crate label was left unchanged.`,
      );
    } else if (res.data.crateSyncRackPreserved) {
      // The rack label was KEPT rather than erased, because nobody was shown the
      // erasure. Saying so is the whole reason keeping it is safe: a stale label
      // somebody knows about is recoverable, a wiped one is not.
      toast.warning(
        `${itemName} was placed, but its rack label was left as it was and may now be wrong — nobody was asked about clearing it.`,
      );
    } else if (res.data.crateSyncCratePreserved) {
      // Its twin for the CRATE label (Maus I, 2026-08-17). A plain-rack
      // put-away for a book that records a crate, with no acknowledged clear —
      // the label was KEPT rather than erased. With the fields pre-filled from
      // current storage this dialog places INTO the recorded crate, so the
      // ordinary path never reaches here; an old snapshot or a race can.
      toast.warning(
        `${itemName} was placed, but its crate label was left as it was and may now be wrong — nobody was asked about clearing it.`,
      );
    }
    setPendingConfirm(null);
    setOpen(false);
    // Staging must re-render: a PARTIAL placement leaves the remainder in the
    // source bucket, and that row has to come back with its new quantity.
    router.refresh();
  }

  function submit() {
    if (!qtyValid) {
      toast.error(`Quantity must be between 1 and ${availableQuantity}.`);
      return;
    }

    const dest = chosenDestination();
    if (!dest) {
      toast.error('Select a destination location.');
      return;
    }
    // THE LAST GATE BEFORE ANY CONFIRMATION IS BUILT. `destinationLabel` is ''
    // for an invalid plan, and describeNewRackPlacement would happily dress
    // that up as "Create new crate ? does not exist in Main Warehouse yet."
    // Refusing here means no creation prompt can ever name nothing — and the
    // words are the planner's, so the toast, the inline message and the
    // server's zod issue are one sentence.
    const plan = planNewDestination(dest);
    if (plan?.kind === 'invalid') {
      toast.error(plan.message);
      return;
    }

    const destination = toActionDestination(dest);

    // 1. Does this OVERWRITE a crate someone recorded? Predicted with the same
    //    comparator the server gate uses, against the book's summary and the
    //    destination's own crate columns (never re-typed metadata).
    //
    //    `bookStorage` is an RSC snapshot taken when the page rendered, so this
    //    prediction can be WRONG — someone may have re-crated the book from the
    //    item screen since. That is fine now and used to be a data-loss bug:
    //    the acknowledgement below names the crate this dialog actually showed,
    //    so a snapshot that no longer matches the row is refused by the server
    //    and re-asked against current truth instead of waving the write through.
    const next = destinationCrate(dest);
    // The rack halves are LABEL context on both sides — the comparison stays
    // crate-only (see BookCratePlacementInput), but "Blue 4" and "Blue 13" mean
    // little without the rack each sits on when one crate number names five
    // different bins.
    const currentPosition = { rackNumber: bookStorage?.rackNumber, rackRow: bookStorage?.rackRow };
    const nextPosition = destinationPosition(dest);
    const crateChange =
      isBook && bookStorage
        ? describeBookCrateConflict({
            itemId,
            itemName,
            currentColor: bookStorage.crateColor,
            currentNumber: bookStorage.crateNumber,
            currentPosition,
            nextColor: next.color,
            nextNumber: next.number,
            nextPosition,
          })
        : null;
    // ═══ WHEN THIS DIALOG CANNOT STATE THE RACK OUTCOME, IT DEFERS ═══
    //
    // The destination states NO rack position and the book records one. What
    // happens to that pair is then decided by the LIVE HOLDINGS after the move:
    // `syncBookCratePlacementInner` derives both summaries from the single
    // location the stock resolves to, so a FULL move CLEARS the rack and a
    // SPLIT leaves it alone. This dialog holds an RSC snapshot of the item's
    // summary and no holdings at all, so it can tell neither.
    //
    // The owner walked exactly this: rack 38-A, 18 units in staging, placed
    // into position-less "Blue #Shelf". The dialog named both crate fields,
    // said nothing about the rack — because the two-argument comparison
    // genuinely could not — and pre-acknowledged the change, so the SERVER gate
    // (which does read the holdings) was satisfied and never spoke. 38-A was
    // gone at rest, silently.
    //
    // Guessing here is not the fix: a promise that is right half the time is
    // the same class of lie as the silence. So the dialog does the one honest
    // thing it can — it declines to answer a question it cannot state in full,
    // withholds its acknowledgement, and lets the gate ask. The refusal handler
    // in `place()` renders the server's payload, which names the rack plainly.
    //
    // This is the shipped pattern, not a new one: StockTransferDialog has
    // always sent `acknowledged: []` and let the server ask. The local
    // prediction is an optimisation that saves a round trip; when it would cost
    // honesty, it is dropped. It also removes a false alarm — when the holdings
    // say SPLIT the gate drops the conflict entirely, so the operator is now
    // asked nothing at all for a change that provably cannot happen.
    //
    // ═══ AND A MINT IS NOT AN EXCEPTION — IT WAS THE SAME BUG, ONE BRANCH OVER ═══
    //
    // This condition used to carry `!creating`, on the reasoning that "Create
    // new crate Green #7?" has no server gate behind it, so a creation had to
    // keep the local prediction or one confirmation would become two. That
    // traded the operator's disclosure for the dialog's tidiness — and it kept
    // the original data-loss bug alive on the sibling branch. Reproduced: a book
    // recorded in crate Orange 13 ON RACK 38-A, all 18 units in staging, placed
    // into a brand-new position-less "Crate #7". The confirmation read "Crate
    // color Orange will be cleared. Crate number will change from 13 to 7." and
    // never said 38-A; it pre-acknowledged, so the gate — which reads the
    // holdings and WOULD have said "Rack 38-A will be cleared." — was waived,
    // and the rack pair was gone at rest.
    //
    // Minting changes nothing about WHY this component cannot answer. The
    // destination's crate values do come from this form, but the rack outcome is
    // decided by the ITEM's live holdings (`syncBookCratePlacementInner` derives
    // both pairs from the single location the stock resolves to), and creating
    // the location does not teach this dialog those holdings.
    //
    // So the mint branch defers too, and the two questions are asked in the only
    // honest order available:
    //
    //   1. THIS dialog asks the one question only it can — "Crate #7 does not
    //      exist in Main Warehouse yet, create it?" — with its near-match
    //      alternatives. It claims nothing about the crate or the rack, because
    //      it can support neither.
    //   2. The request goes out UNACKNOWLEDGED. The gate reads the holdings,
    //      refuses, and the handler in `place()` re-renders THE SAME dialog with
    //      the server's sentences — the rack one included.
    //
    // That is one dialog ADVANCING, not two stacking: `setPendingConfirm`
    // replaces the content of the confirmation already on screen. It is also
    // exactly what the phone has always done (move-stock-modal.tsx asks the
    // creation Alert, never pre-acknowledges, and re-asks from the gate's
    // payload), so the two clients finally agree.
    //
    // THE COST, stated plainly: a location minted at step 1 outlives a Cancel at
    // step 2 as an empty rack/crate row. Litter, and recoverable by hand; the
    // alternative was an erasure the operator was never shown.
    const deferToServer =
      crateChange !== null &&
      !hasRackPosition(nextPosition) &&
      hasRackPosition(currentPosition);

    // 2. Does it MINT a location? describeNewRackPlacement checks the label
    //    against this warehouse's existing rack/crate names — an existing
    //    label is reused by the server, so it is not a creation and needs no
    //    confirmation (zero friction on the common path).
    //
    //    SUPPRESSED when the fields ARE the book's recorded storage. For a
    //    label-only crate — most crates in this warehouse — no row exists yet,
    //    so the typo guard would fire on every put-away of every crated book,
    //    for a destination the operator did not type but the record supplied.
    //    That is the recorded truth being minted as a row for the first time,
    //    not a typo; the near-match suggestions stay for anything typed.
    const recordedStorage = isBook && destinationIsRecordedStorage(dest, bookStorage);
    const creation =
      dest.mode === 'existing' || recordedStorage
        ? null
        : describeNewRackPlacement({
            label: destinationLabel(dest),
            warehouseName,
            quantity: qtyNum,
            existingLabels: destinations.map((d) => d.name),
            noun: isCrateChoice(dest) ? 'crate' : 'rack',
          });
    const creating = creation !== null && !creation.exists;
    const crateLines =
      isBook && bookStorage && crateChange && !deferToServer
        ? describeBookCrateChange({
            currentColor: bookStorage.crateColor,
            currentNumber: bookStorage.crateNumber,
            nextColor: next.color,
            nextNumber: next.number,
          })
        : [];

    if (!creating && crateLines.length === 0) {
      void place(destination, { describe: dest });
      return;
    }

    // ONE dialog for both questions. Notices carry the things that are true
    // but not questions: the remainder left behind by a partial placement, and
    // the rack label this also changes.
    const notices: string[] = [];
    const remainder = remainderNotice();
    if (remainder) notices.push(remainder);
    // THE RACK LINE IS ITS OWN COMPARISON — and it now covers a CRATE that
    // sits on a rack, which the old `!isCrateChoice(dest)` guard skipped
    // entirely. The basis is `'unknown'` because it is: this dialog has a
    // render-time snapshot of the item summary and no holdings, so it may state
    // a MOVE (the destination names the rack it is moving to — true whichever
    // way the holdings fall) and may never promise a CLEAR. The case where a
    // clear is the outcome is the one routed to the server above; that payload
    // carries the sentence, derived from the holdings the gate read.
    if (isBook && bookStorage) {
      const rackLine = describeRackChange(currentPosition, nextPosition, 'unknown');
      if (rackLine) notices.push(rackLine);
    }

    setPendingConfirm({
      content: {
        title: creating ? creation!.title : 'Change this book’s crate?',
        message: creating
          ? creation!.message
          : `${itemName} is recorded in ${bookStorage?.crateLabel ?? 'a different crate'}.`,
        ...(creating && creation!.suggestions.length > 0
          ? { suggestions: creation!.suggestions }
          : {}),
        ...(crateLines.length > 0 ? { crateLines } : {}),
        ...(notices.length > 0 ? { notices } : {}),
        confirmLabel: creating ? 'Create and place' : 'Continue placement',
      },
      destination,
      // ONLY the change this dialog just described, fingerprinted. An empty
      // array when the confirmation is purely about minting a rack: that
      // question has nothing to do with the book's crate, and answering it must
      // not also answer one the user was never asked.
      //
      // Empty for `deferToServer` too, and for the same reason: this dialog did
      // not describe the rack the placement is about to erase, so it has not
      // earned an acknowledgement. The gate refuses, and the operator answers
      // the server's fuller question instead.
      acknowledged:
        crateChange && !deferToServer ? toBookCrateAcknowledgement([crateChange]) : [],
      // NEVER PRE-ACKNOWLEDGED FROM A SNAPSHOT. A rack erasure depends on the
      // live holdings, which this component has never read, so it has nothing to
      // fingerprint and nothing it could honestly claim to have shown. The empty
      // array still DECLARES the capability (see `place`), which is what makes
      // the server ask instead of silently preserving.
      acknowledgedRacks: [],
    });
  }

  // "Did you mean 10-A?" — place into the EXISTING rack the worker probably
  // meant, instead of creating the typo. The suggestion is an existing label,
  // so map it back to that destination's id and take the existing-location path.
  function placeIntoSuggestion(label: string) {
    const match = destinations.find(
      (d) => d.name.trim().toLowerCase() === label.trim().toLowerCase(),
    );
    if (!match) return;
    setPendingConfirm(null);
    void place(
      { existingLocationId: match.id },
      { describe: { mode: 'existing', option: match } },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <PackageCheck className="h-4 w-4" />
            Place
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Place from {sourceLabel.toLowerCase()}</DialogTitle>
          <DialogDescription>
            Move <span className="font-medium text-foreground">{itemName}</span> from{' '}
            {sourceLabel.toLowerCase()} into a rack or crate. Available:{' '}
            <span className="tabular-nums">{availableQuantity}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Where this book is recorded today — context for the decision. */}
          {isBook && bookStorage && <CurrentStorageSummary storage={bookStorage} />}

          {/* Fixed source */}
          <div className="space-y-1.5">
            <Label>From</Label>
            <div className="bg-muted text-muted-foreground flex h-9 items-center rounded-md border px-3 text-sm">
              {sourceLabel}
            </div>
          </div>

          {/* ═══ BOOKS: the four fields ARE the destination ═══ */}
          {isBook ? (
            <>
              {/* Existing-location shortcut — FILLS the four fields below. */}
              <div className="space-y-1.5">
                <Label id="place-existing-label">Pick an existing rack / crate (optional)</Label>
                <Select value={destId} onValueChange={pickExisting}>
                  <SelectTrigger aria-labelledby="place-existing-label">
                    <SelectValue placeholder="Fill in from an existing location" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* An EXISTING crate already carries its metadata — show it
                    rather than making the user re-type what the row holds. */}
                {selectedDestination && (
                  <DestinationCrateNote
                    crateColor={selectedDestination.crateColor}
                    crateNumber={selectedDestination.crateNumber}
                  />
                )}
              </div>

              <BookDestinationFields
                idPrefix="place"
                fields={fields}
                onChange={setFields}
                unknownCrateColor={unknownCrateColor}
                problem={newProblem}
              />
            </>
          ) : (
            <>
              {/* Destination picker */}
              <div className="space-y-1.5">
                <Label>To location</Label>
                <Select value={destId} onValueChange={pickExisting}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_RACK_SENTINEL}>+ New rack / crate</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Inline new rack inputs */}
              {isNew && (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="place-rack-number">
                        Rack number <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="place-rack-number"
                        placeholder="e.g. A1"
                        value={rackNumber}
                        onChange={(e) => setField('rackNumber')(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="place-rack-row">Row (optional)</Label>
                      <Input
                        id="place-rack-row"
                        placeholder="e.g. Row 3"
                        value={rackRow}
                        onChange={(e) => setField('rackRow')(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* The planner's refusal, said where the fields are. Without
                      it a half-filled form would just have a dead Place button
                      and no explanation. */}
                  {newProblem && <p className="text-destructive text-xs">{newProblem}</p>}
                </div>
              )}
            </>
          )}

          {/* Quantity — supports split */}
          <div className="space-y-1.5">
            <Label htmlFor="place-quantity">
              Quantity{' '}
              <span className="text-muted-foreground font-normal">
                (max {availableQuantity})
              </span>
            </Label>
            <Input
              id="place-quantity"
              type="number"
              step="1"
              min="1"
              max={availableQuantity}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {quantity !== '' && !qtyValid && (
              <p className="text-destructive text-[11px]">
                Must be between 1 and {availableQuantity}.
              </p>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="place-notes">Notes (optional)</Label>
            <Textarea
              id="place-notes"
              rows={2}
              value={notes}
              maxLength={2000}
              placeholder="Reason for placement…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Place stock'}
          </Button>
        </DialogFooter>
      </DialogContent>

      <PlacementConfirmDialog
        open={pendingConfirm !== null}
        content={pendingConfirm?.content ?? null}
        submitting={submitting}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (!pendingConfirm) return;
          const dest = chosenDestination();
          void place(pendingConfirm.destination, {
            acknowledged: pendingConfirm.acknowledged,
            acknowledgedRacks: pendingConfirm.acknowledgedRacks,
            ...(dest ? { describe: dest } : {}),
          });
        }}
        onUseSuggestion={placeIntoSuggestion}
      />
    </Dialog>
  );
}
