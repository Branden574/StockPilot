'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { MAINTENANCE_RESOLUTION_NOTE_MAX, maintenanceResolveSchema } from '@stockpilot/core';

import { MaintenancePhotosPanel, type PanelPhoto } from '@/components/maintenance/maintenance-photos-panel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { resolveMaintenanceRequestAction } from '@/server/actions/maintenance-requests';

interface Props {
  requestId: string;
  /** Interpolated into the disclosure copy below — the requester who gets
   *  the resolution email (spec §6). Never used for authorization; that
   *  stays entirely server-side in resolve(). */
  requesterName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired AFTER a successful resolve() call and the dialog has already
   *  closed itself — the caller's own hook for `router.refresh()` (matches
   *  the archive/cancel `doArchive`/`doCancel` convention one level up in
   *  detail-client.tsx), kept separate from onOpenChange so a test can pin
   *  each independently (brief Step 1 test 2). */
  onResolved: () => void;
}

/** Shape this dialog cares about from GET /api/v1/maintenance-requests/[id]
 *  (Task 4's route, already returns `photos[]` with `kind` per spec §4.1) —
 *  declared locally, matching maintenance-photos-panel.tsx's own
 *  fetch-boundary convention rather than importing a server-only type into
 *  a client file. */
interface DetailPhotosResponse {
  photos?: Array<{
    id: string;
    originalFilename: string;
    url: string;
    thumbUrl: string | null;
    kind?: string;
  }>;
}

/**
 * Manage-persona close-out dialog (spec §8). Required resolution note,
 * optional proof photos uploaded THROUGH the existing attachment pipeline
 * with `kind="resolution"` (mint/PUT/finalize happen immediately, before
 * the confirm click — spec §12.5's pre-flip staging: a cancelled dialog
 * leaves removable `kind='resolution'` rows on the still-open request,
 * which is designed, disclosed behavior, not a bug). The note is validated
 * client-side with the SAME `.strict()` schema the server re-parses
 * (`maintenanceResolveSchema`, packages/core) — no parallel min/max rules
 * are hand-rolled here.
 */
export function ResolveRequestDialog({ requestId, requesterName, open, onOpenChange, onResolved }: Props) {
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState<PanelPhoto[]>([]);
  const [pending, setPending] = React.useState(false);

  // Loads the CURRENT kind='resolution' rows for this request — populates
  // the panel with anything already uploaded in this or a prior (cancelled)
  // dialog session, and refreshes after every upload/remove so the panel's
  // own remove affordance always operates on real, live rows (spec §8: "the
  // panel's existing remove affordance handles that"). Best-effort: a
  // failed load never blocks resolving — resolve()'s own live count is the
  // authority on proof_photo_count, not this preview.
  const loadResolutionPhotos = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/maintenance-requests/${requestId}`);
      if (!res.ok) return;
      const data = (await res.json()) as DetailPhotosResponse;
      setPhotos(
        (data.photos ?? [])
          .filter((p) => p.kind === 'resolution')
          .map((p) => ({ id: p.id, originalFilename: p.originalFilename, url: p.url, thumbUrl: p.thumbUrl })),
      );
    } catch {
      // Best-effort preview only (see doc comment above).
    }
  }, [requestId]);

  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open, matches destructive-confirm.tsx's own idiom
    setNote('');
    void loadResolutionPhotos();
  }, [open, loadResolutionPhotos]);

  // Client hint only — the server re-parses with this SAME schema and is
  // the authority (doc comment on resolveMaintenanceRequestAction).
  const valid = maintenanceResolveSchema.safeParse({ note }).success;
  const confirmDisabled = pending || !valid;

  async function handleConfirm() {
    if (confirmDisabled) return;
    setPending(true);
    const res = await resolveMaintenanceRequestAction(requestId, { note });
    setPending(false);
    if ('error' in res) {
      toast.error(res.error.message);
      // Stays open on error — unlike archive/cancel, losing the typed note
      // and any staged proof photos to a transient failure would be worse
      // here than making the user dismiss the dialog themselves.
      return;
    }
    toast.success('Request marked resolved.');
    onOpenChange(false);
    onResolved();
  }

  function handleOpenChange(next: boolean) {
    if (pending && !next) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Resolve this maintenance request?</DialogTitle>
          <DialogDescription>
            {`Marks this request resolved in StockPilot and emails ${requesterName} the note and any proof photos. It does not close or update the Zendesk ticket.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="resolve-note">Resolution note</Label>
            <Textarea
              id="resolve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={MAINTENANCE_RESOLUTION_NOTE_MAX}
              placeholder="Describe how the issue was resolved..."
              disabled={pending}
              aria-required="true"
            />
            <p className="text-muted-foreground text-xs">Required. {MAINTENANCE_RESOLUTION_NOTE_MAX} characters max.</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">Proof photos (optional)</p>
            <p className="text-muted-foreground text-xs">
              Proof photos upload immediately and stay attached to this request even if you close this dialog
              without confirming. Remove any you do not want to keep before confirming.
            </p>
            <MaintenancePhotosPanel
              requestId={requestId}
              photos={photos}
              onChange={() => void loadResolutionPhotos()}
              kind="resolution"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="default" onClick={() => void handleConfirm()} disabled={confirmDisabled}>
            {pending ? 'Resolving...' : 'Mark resolved'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
