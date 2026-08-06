'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { MaintenancePhotosPanel, type PanelPhoto } from '@/components/maintenance/maintenance-photos-panel';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  archiveMaintenanceRequestAction,
  cancelMaintenanceRequestAction,
} from '@/server/actions/maintenance-requests';

/**
 * Page-specific glue, not reusable components — kept colocated with the
 * route it serves rather than in components/maintenance (mirrors
 * new-request-client.tsx's own doc comment one directory up). A Server
 * Component cannot pass a plain closure as a prop to a Client Component, so
 * both the photos panel's `onChange` and the Archive/Cancel confirm flows
 * have to live here, on the client, where `useRouter()` is available.
 */
export function MaintenancePhotosPanelClient({
  requestId,
  photos,
}: {
  requestId: string;
  photos: PanelPhoto[];
}) {
  const router = useRouter();
  return <MaintenancePhotosPanel requestId={requestId} photos={photos} onChange={() => router.refresh()} />;
}

interface ActionsProps {
  requestId: string;
  /** Task 8's archive() is manage-only. */
  showArchive: boolean;
  /** Task 8's cancel() allows the owning requester (or manage, handled by
   *  showArchive's own button for the manage persona) pre-close. */
  showCancel: boolean;
}

/**
 * Archive (manage) / Cancel (requester) — brief step 3's "Archive/Cancel
 * buttons (manage / requester respectively) wired to the Task 8 actions with
 * confirm dialogs." Both actions revalidate this page server-side already;
 * `router.refresh()` re-renders the CURRENT client tree against that fresh
 * data (the request is now closed, so the buttons disappear on next render).
 */
export function MaintenanceRequestActions({ requestId, showArchive, showCancel }: ActionsProps) {
  const router = useRouter();
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function doArchive() {
    setPending(true);
    const res = await archiveMaintenanceRequestAction(requestId);
    setPending(false);
    setArchiveOpen(false);
    if ('error' in res) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Request archived.');
    router.refresh();
  }

  async function doCancel() {
    setPending(true);
    const res = await cancelMaintenanceRequestAction(requestId);
    setPending(false);
    setCancelOpen(false);
    if ('error' in res) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Request cancelled.');
    router.refresh();
  }

  if (!showArchive && !showCancel) return null;

  return (
    <div className="flex items-center gap-2">
      {showCancel ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setCancelOpen(true)}>
          Cancel request
        </Button>
      ) : null}
      {showArchive ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setArchiveOpen(true)}
        >
          Archive
        </Button>
      ) : null}

      <DestructiveConfirm
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this maintenance request?"
        description="The request is marked cancelled and can no longer be edited. Cancelling here does not notify anyone by email — if an Outlook draft was already sent, follow up separately."
        confirmLabel="Cancel request"
        pending={pending}
        onConfirm={doCancel}
      />
      <DestructiveConfirm
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this maintenance request?"
        description="The request is marked archived and can no longer be edited. Use this for duplicates or requests that are already resolved."
        confirmLabel="Archive"
        pending={pending}
        onConfirm={doArchive}
      />
    </div>
  );
}
