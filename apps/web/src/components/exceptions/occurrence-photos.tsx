'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  MaintenancePhotosPanel,
  PhotoAnswerLostError,
  type PanelPhoto,
  type PhotoPanelEndpoints,
} from '@/components/maintenance/maintenance-photos-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  finalizeExceptionEvidenceAction,
  removeExceptionEvidenceAction,
  startExceptionEvidenceUploadAction,
} from '@/server/actions/exceptions';
import type { ExceptionEvidenceBlock } from '@/server/services/lib/exception-evidence-read';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_CONTENT_TYPES,
  EXCEPTION_EVIDENCE_LIMITS_COPY,
  EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NONE_COPY,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_EVIDENCE_PRIVACY_COPY,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
  EXCEPTION_EVIDENCE_REMOVE_COPY,
  EXCEPTION_EVIDENCE_UNAVAILABLE_COPY,
  exceptionEvidenceAddDisabledReason,
  exceptionEvidenceAddedByCopy,
  exceptionEvidenceCountLabel,
  exceptionEvidenceTimesCopy,
} from '@stockpilot/core';

/** A server action that never answered (the connection dropped): nothing is
 *  known about whether it ran. */
export const EVIDENCE_CONNECTION_COPY = "Couldn't reach the server. Check your connection and try again.";

const ALLOWED_TYPES: ReadonlySet<string> = new Set(EXCEPTION_EVIDENCE_CONTENT_TYPES);

/**
 * The photo panel's endpoints for one occurrence (F1-4): the web twins of
 * POST/DELETE /api/v1/exceptions/[id]/evidence, as server actions.
 *
 *   - mint: a photo the bucket would refuse (not JPEG, PNG or WEBP after the
 *     browser's conversion, for example a HEIC the browser cannot decode, or
 *     over 10 MB) is refused here, before anything is sent.
 *   - finalize: sends no capture time. A browser does not know when a photo
 *     was taken (a file's modified time is not that), so the timeline says the
 *     device did not say, rather than presenting a guess as "Taken".
 *     A finalize that never answered throws PhotoAnswerLostError, so Retry
 *     resends it for the same upload; "already_recorded" then means that
 *     earlier finalize landed, which is success, not a second photo.
 *   - remove: a soft remove with the optional reason.
 *
 * Every failure the server answered carries its message (the action's
 * `error.message`); the gate, the cap and the open check are the server's.
 */
export function exceptionEvidenceEndpoints(occurrenceId: string): PhotoPanelEndpoints {
  return {
    async mint({ fileExt, declaredMime, byteSize }) {
      if (!ALLOWED_TYPES.has(declaredMime) || byteSize <= 0 || byteSize > EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES) {
        throw new Error(EXCEPTION_EVIDENCE_REJECTED_COPY);
      }
      let res: Awaited<ReturnType<typeof startExceptionEvidenceUploadAction>>;
      try {
        res = await startExceptionEvidenceUploadAction(occurrenceId, { fileExt });
      } catch {
        throw new Error(EVIDENCE_CONNECTION_COPY);
      }
      if ('error' in res) throw new Error(res.error.message);
      // No thumbnail URL: the server makes the thumbnail from the cleaned photo.
      return { path: res.ticket.path, signedUrl: res.ticket.signedUrl };
    },
    async finalize({ path, declaredMime, note }) {
      let res: Awaited<ReturnType<typeof finalizeExceptionEvidenceAction>>;
      try {
        res = await finalizeExceptionEvidenceAction(occurrenceId, {
          path,
          declaredMime,
          capturedAt: null,
          note,
        });
      } catch {
        throw new PhotoAnswerLostError(EVIDENCE_CONNECTION_COPY);
      }
      if ('error' in res) {
        if (res.error.reason === 'already_recorded') return;
        throw new Error(res.error.message);
      }
    },
    async remove(photoId, reason) {
      let res: Awaited<ReturnType<typeof removeExceptionEvidenceAction>>;
      try {
        res = await removeExceptionEvidenceAction(occurrenceId, photoId, reason);
      } catch {
        throw new Error(EVIDENCE_CONNECTION_COPY);
      }
      if ('error' in res) throw new Error(res.error.message);
    },
  };
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** The browser's own online flag. The server render assumes online; a false
 *  "online" (a connection that does not reach us) surfaces as a failed call. */
function useOnline(): boolean {
  return React.useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  );
}

/**
 * PHOTOS on one exception occurrence (F1-4), on the occurrence detail.
 *
 * Everyone who can open the exception sees its live photos, each with its
 * note, who added it and its two times (core exceptionEvidenceTimesCopy: the
 * device's clock and the server's). Adding is offered only to a reader who
 * passes the act gate (`canAct`, the same gate as Acknowledge and Add note)
 * on an open exception, under the 8-photo cap, while online; everyone else
 * reads why (core exceptionEvidenceAddDisabledReason). Remove is offered where
 * the server says so (the uploader or a manager, open, the act gate), asks
 * first with an optional reason, and is a soft remove. The database re-checks
 * all of it on every call.
 *
 * A failed photo read says so and offers a retry; it is never shown as
 * "No photos yet." (pattern #1). Photos are online only: there is no queue.
 */
export function OccurrencePhotos({
  occurrenceId,
  evidence,
  resolved,
  canAct,
  timeZone,
}: {
  occurrenceId: string;
  evidence: ExceptionEvidenceBlock;
  resolved: boolean;
  canAct: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const online = useOnline();
  const endpoints = React.useMemo(() => exceptionEvidenceEndpoints(occurrenceId), [occurrenceId]);

  if (evidence.status !== 'ok') {
    return (
      <Card data-testid="occurrence-photos">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Photos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p role="alert" className="text-muted-foreground text-sm">
            {EXCEPTION_EVIDENCE_UNAVAILABLE_COPY}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const readOnly = resolved || !canAct;
  const addDisabledReason = exceptionEvidenceAddDisabledReason({
    resolved,
    canAct,
    online,
    liveCount: evidence.liveCount,
  });
  const photos: PanelPhoto[] = evidence.photos.map((p, i) => ({
    id: p.id,
    originalFilename: `Photo ${i + 1}`,
    url: p.url,
    thumbUrl: p.thumbUrl,
    // Removing needs a connection too.
    canRemove: p.canRemove && online,
    caption: {
      note: p.note,
      lines: [exceptionEvidenceAddedByCopy(p.uploadedBy.label), exceptionEvidenceTimesCopy(p, timeZone)],
    },
  }));

  return (
    <Card data-testid="occurrence-photos">
      <CardContent className="pt-6">
        <MaintenancePhotosPanel
          endpoints={endpoints}
          photos={photos}
          onChange={() => router.refresh()}
          variant="card"
          ariaLabel="Exception photos"
          maxPhotos={EXCEPTION_EVIDENCE_MAX_PHOTOS}
          countLabel={exceptionEvidenceCountLabel(evidence.liveCount)}
          capMessage={EXCEPTION_EVIDENCE_CAP_COPY}
          readOnly={readOnly}
          addDisabledReason={addDisabledReason}
          noteField={{
            label: 'Note (optional, saved with each photo you add)',
            max: EXCEPTION_EVIDENCE_NOTE_MAX,
            placeholder: 'What the photo shows',
          }}
          removal={{
            title: 'Remove this photo?',
            description: EXCEPTION_EVIDENCE_REMOVE_COPY,
            reasonLabel: 'Reason (optional)',
            reasonMax: EXCEPTION_EVIDENCE_NOTE_MAX,
            confirmLabel: 'Remove photo',
          }}
          emptyText={EXCEPTION_EVIDENCE_NONE_COPY}
          footnote={readOnly ? [EXCEPTION_EVIDENCE_PRIVACY_COPY] : [EXCEPTION_EVIDENCE_LIMITS_COPY, EXCEPTION_EVIDENCE_PRIVACY_COPY]}
        />
      </CardContent>
    </Card>
  );
}
