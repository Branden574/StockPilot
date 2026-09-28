import { Image } from 'expo-image';
import { Camera } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import {
  EXCEPTION_EVIDENCE_LIMITS_COPY,
  EXCEPTION_EVIDENCE_NONE_COPY,
  EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY,
  EXCEPTION_EVIDENCE_PRIVACY_COPY,
  EXCEPTION_EVIDENCE_UNAVAILABLE_COPY,
  exceptionEvidenceAddedByCopy,
  exceptionEvidenceCountLabel,
  exceptionEvidenceTimesCopy,
} from '@stockpilot/core';

import {
  EvidenceAddSheet,
  EvidenceRemoveSheet,
  type PickedEvidencePhoto,
} from '@/components/exception-evidence-sheets';
import { MIN_TAP } from '@/components/item-verification-card';
import { PhotoViewer } from '@/components/photo-viewer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body, Eyebrow } from '@/components/ui/text';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import {
  EVIDENCE_REMOVE_OFFLINE_COPY,
  evidenceAddControl,
  evidenceCapCheck,
  evidencePhotoFailed,
  evidenceQueueRowCopy,
  evidenceRetryDisabledReason,
  evidenceRoomLeft,
  evidenceSectionParts,
  evidenceTick,
  visibleEvidenceQueue,
  type EvidenceQueueEntry,
  type MobileEvidenceBlock,
  type MobileEvidencePhoto,
} from '@/lib/exception-evidence';
import { asEvidenceFailure, runEvidenceAttempt } from '@/lib/exception-evidence-upload';
import { createPhotoAttemptGuard } from '@/lib/signed-photo-upload';
import { ACCENT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The Photos section of one exception (F1-4): the photos the server listed,
 * one row per photo being added, and the add control.
 *
 *   - ONLINE ONLY. Offline the add control stays, disabled, with core's words
 *     (nothing is saved for later), and so do Retry and Remove.
 *   - A photo is shown as added only once the server recorded it. Each photo
 *     being added has its own row: "Uploading", "Added" (recorded, not yet in
 *     the list), or "Not added" with the reason, a Retry where one can help
 *     and Discard. Nothing on this screen counts as a photo until the server
 *     says so, so a failed upload leaves no phantom photo.
 *   - Add photo opens EvidenceAddSheet: the camera (the photo library
 *     instead when the camera is not allowed, or there is none, as in the
 *     simulator) or the library, then an optional note.
 *   - Remove is offered where the server says this reader may remove the
 *     photo (the uploader or a manager, while the exception is open).
 *   - The photos could not be read: the section says so, with Try again, and
 *     offers no add (an unknown count is never room to spare). The rows of
 *     photos being added stay, with their Retry and Discard, whatever the
 *     read says (evidenceSectionParts).
 *   - A photo whose image fails to load (its 1-hour link expired, the file
 *     cannot be read), in the list or in the viewer, says so with Try again,
 *     which reads the exception again for fresh links. Never a blank.
 */

function localKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ExceptionEvidenceSection({
  occurrenceId,
  block,
  readTick,
  resolved,
  canAct,
  online,
  timeZone,
  onChanged,
}: {
  occurrenceId: string;
  block: MobileEvidenceBlock;
  /** The tick the read that produced `block` started at (evidenceTick). */
  readTick: number;
  resolved: boolean;
  canAct: boolean;
  online: boolean;
  timeZone: string | null;
  /** Re-read the exception (after a photo is added or removed, and Try again). */
  onChanged: () => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stack = shouldStackRow(fontScale);
  const [queue, setQueue] = React.useState<EvidenceQueueEntry[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<MobileEvidencePhoto | null>(null);
  const [viewing, setViewing] = React.useState<MobileEvidencePhoto | null>(null);
  // Image URLs that failed to load here; fresh links (a re-read) try again.
  const [failedUrls, setFailedUrls] = React.useState<ReadonlySet<string>>(() => new Set());
  const markFailed = React.useCallback((url: string) => {
    setFailedUrls((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
  }, []);
  // One attempt counter per photo row: a late answer from an attempt a Retry
  // replaced is dropped, never applied (createPhotoAttemptGuard).
  const [guard] = React.useState(createPhotoAttemptGuard);

  const visible = visibleEvidenceQueue(queue, block, readTick);
  const parts = evidenceSectionParts(block, visible);
  const liveCount = block.status === 'ok' ? block.liveCount : 0;
  const add = evidenceAddControl({ block, resolved, canAct, online, visible });
  const retryReason = evidenceRetryDisabledReason(online);

  function patch(key: string, next: Partial<EvidenceQueueEntry>) {
    setQueue((prev) => prev.map((e) => (e.key === key ? { ...e, ...next } : e)));
  }

  async function runUpload(entry: EvidenceQueueEntry) {
    const token = guard.start(entry.key);
    try {
      const res = await runEvidenceAttempt({
        occurrenceId,
        asset: { uri: entry.uri, fileName: entry.fileName },
        capturedAt: entry.capturedAt,
        note: entry.note,
        // Only a 'record' retry resumes: the bytes are on the server and the
        // answer was lost, so the same upload is recorded rather than a copy.
        resume: entry.retry === 'record' ? entry.resume : null,
        onProgress: (fraction) => {
          if (guard.isCurrent(entry.key, token)) patch(entry.key, { progress: fraction });
        },
      });
      if (!guard.isCurrent(entry.key, token)) return;
      patch(entry.key, {
        status: 'done',
        progress: 1,
        message: undefined,
        retry: null,
        resume: null,
        evidenceId: res.evidenceId,
        doneAt: evidenceTick(),
      });
    } catch (e) {
      if (!guard.isCurrent(entry.key, token)) return;
      const failure = asEvidenceFailure(e);
      patch(entry.key, {
        status: 'error',
        progress: 0,
        message: failure.message,
        retry: failure.retry,
        resume: failure.resume,
      });
      // A refusal (resolved, the cap, no permission) means the exception
      // changed: read it again so the section says so.
      if (failure.retry === null) onChanged();
      return;
    }
    // Outside the try: the photo is recorded. A failed re-read is the
    // screen's to report ("Could not refresh"); it never marks this row
    // failed, and the row stays, saying it was added, until a read shows it.
    onChanged();
  }

  async function addPicked(photos: readonly PickedEvidencePhoto[], note: string | null) {
    const entries: EvidenceQueueEntry[] = photos.map((p) => ({
      key: localKey(),
      uri: p.uri,
      fileName: p.fileName,
      capturedAt: p.capturedAt,
      note,
      status: 'uploading',
      progress: 0,
      retry: null,
      resume: null,
      evidenceId: null,
      doneAt: null,
    }));
    // Rows a read already shows are dropped as the new ones go in.
    setQueue((prev) => [...visibleEvidenceQueue(prev, block, readTick), ...entries]);
    for (const entry of entries) {
      await runUpload(entry);
    }
  }

  function retry(key: string) {
    const entry = queue.find((e) => e.key === key);
    if (!entry || !online) return;
    patch(key, { status: 'uploading', progress: 0, message: undefined });
    void runUpload({ ...entry, status: 'uploading', progress: 0, message: undefined });
  }

  function discard(key: string) {
    const entry = queue.find((e) => e.key === key);
    setQueue((prev) => prev.filter((e) => e.key !== key));
    // It may have been recorded after all (its answer was lost): the list
    // says, once it is read again.
    if (entry?.retry === 'record') onChanged();
  }

  /** Add from the sheet: the cap once more (photos in flight count), then
   *  one row per photo, uploaded one after another. */
  function addFromSheet(photos: PickedEvidencePhoto[], note: string | null) {
    const cap = evidenceCapCheck({ liveCount, visible, incoming: photos.length });
    if (!cap.ok) {
      Alert.alert('Too many photos', cap.message);
      return;
    }
    setAdding(false);
    void addPicked(photos, note);
  }

  const heading =
    block.status === 'ok' ? exceptionEvidenceCountLabel(block.liveCount).toUpperCase() : 'PHOTOS';

  return (
    <View style={{ gap: 10 }}>
      <Eyebrow>{heading}</Eyebrow>

      {parts.unavailable ? (
        <Card padding={14}>
          <Body size={14} accessibilityRole="alert">
            {EXCEPTION_EVIDENCE_UNAVAILABLE_COPY}
          </Body>
          <Button
            variant="outline"
            size="sm"
            disabled={!online}
            onPress={onChanged}
            style={{ alignSelf: 'flex-start', marginTop: 12, minHeight: MIN_TAP }}
          >
            Try again
          </Button>
        </Card>
      ) : null}

      {parts.showNone ? (
        <Body size={14} muted>
          {EXCEPTION_EVIDENCE_NONE_COPY}
        </Body>
      ) : null}

      {parts.photos.map((p, i) => {
        const failed = evidencePhotoFailed(p, failedUrls);
        return (
          <View key={p.id} style={[styles.row, stack ? styles.stacked : null]}>
            {failed ? (
              <View
                style={[styles.thumb, { backgroundColor: c.paper2 }]}
                accessibilityLabel={`Photo ${i + 1} of ${parts.photos.length} could not be loaded`}
              />
            ) : (
              <Pressable
                onPress={() => setViewing(p)}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Photo ${i + 1} of ${parts.photos.length}. ${exceptionEvidenceAddedByCopy(p.uploadedBy.label)}`}
                accessibilityHint="Opens the photo full screen"
                style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, minHeight: MIN_TAP })}
              >
                <Image
                  source={{ uri: p.thumbUrl ?? p.url }}
                  style={[styles.thumb, { backgroundColor: c.paper2 }]}
                  contentFit="cover"
                  onError={() => markFailed(p.thumbUrl ?? p.url)}
                />
              </Pressable>
            )}
            <View style={stack ? styles.rowTextStacked : styles.rowText}>
              {failed ? (
                <>
                  <Body size={13.5} color={ACCENT.crit} accessibilityRole="alert">
                    {EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY}
                  </Body>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!online}
                    onPress={onChanged}
                    accessibilityLabel={`Try loading photo ${i + 1} again`}
                    style={{ alignSelf: 'flex-start', minHeight: MIN_TAP }}
                  >
                    Try again
                  </Button>
                </>
              ) : null}
              <Body size={14} color={c.ink}>
                {exceptionEvidenceAddedByCopy(p.uploadedBy.label)}
              </Body>
              <Body size={13} muted>
                {exceptionEvidenceTimesCopy(
                  { capturedAt: p.capturedAt, uploadedAt: p.uploadedAt },
                  timeZone,
                )}
              </Body>
              {p.note ? <Body size={14}>{p.note}</Body> : null}
              {p.canRemove ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!online}
                    onPress={() => setRemoving(p)}
                    accessibilityLabel={`Remove photo ${i + 1}`}
                    style={{ alignSelf: 'flex-start', minHeight: MIN_TAP }}
                  >
                    Remove
                  </Button>
                  {!online ? (
                    <Body size={12.5} muted>
                      {EVIDENCE_REMOVE_OFFLINE_COPY}
                    </Body>
                  ) : null}
                </>
              ) : null}
            </View>
          </View>
        );
      })}

      {parts.queue.map((entry) => (
        <View key={entry.key} style={[styles.row, stack ? styles.stacked : null]}>
          <Image
            source={{ uri: entry.uri }}
            style={[
              styles.thumb,
              { backgroundColor: c.paper2, opacity: entry.status === 'error' ? 0.5 : 1 },
            ]}
            contentFit="cover"
            accessibilityLabel="Photo being added"
          />
          <View style={stack ? styles.rowTextStacked : styles.rowText}>
            <Body
              size={13.5}
              color={entry.status === 'error' ? ACCENT.crit : c.ink}
              accessibilityRole={entry.status === 'error' ? 'alert' : undefined}
              accessibilityLiveRegion="polite"
            >
              {evidenceQueueRowCopy(entry)}
            </Body>
            {entry.status === 'uploading' ? (
              <View style={[styles.track, { backgroundColor: c.paper2 }]}>
                <View
                  style={[
                    styles.fill,
                    {
                      backgroundColor: c.ink,
                      width: `${Math.round(Math.min(1, Math.max(0, entry.progress)) * 100)}%`,
                    },
                  ]}
                />
              </View>
            ) : null}
            {entry.status === 'error' ? (
              <View style={styles.rowActions}>
                {entry.retry ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retryReason !== null}
                    onPress={() => retry(entry.key)}
                    accessibilityLabel="Retry adding this photo"
                    style={{ minHeight: MIN_TAP }}
                  >
                    Retry
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => discard(entry.key)}
                  accessibilityLabel="Discard this photo"
                  style={{ minHeight: MIN_TAP }}
                >
                  Discard
                </Button>
              </View>
            ) : null}
            {entry.status === 'error' && entry.retry && retryReason ? (
              <Body size={12.5} muted>
                {retryReason}
              </Body>
            ) : null}
          </View>
        </View>
      ))}

      {parts.unavailable ? null : (
        <>
          {add.offered ? (
            <Button
              block
              variant="outline"
              leading={<Camera size={16} color={c.ink} strokeWidth={1.5} />}
              disabled={add.reason !== null}
              onPress={() => setAdding(true)}
              accessibilityHint="Take a photo or choose one from your library"
            >
              Add photo
            </Button>
          ) : null}
          {add.reason ? (
            <Body size={13} muted>
              {add.reason}
            </Body>
          ) : null}
          {/* The web panel's footnotes: the limits where photos can be added,
              and what happens to location data, always. */}
          {add.offered ? (
            <Body size={12.5} muted>
              {EXCEPTION_EVIDENCE_LIMITS_COPY}
            </Body>
          ) : null}
          <Body size={12.5} muted>
            {EXCEPTION_EVIDENCE_PRIVACY_COPY}
          </Body>
        </>
      )}

      <EvidenceAddSheet
        visible={adding}
        room={evidenceRoomLeft(liveCount, visible)}
        online={online}
        onClose={() => setAdding(false)}
        onAdd={addFromSheet}
      />

      <EvidenceRemoveSheet
        visible={removing !== null}
        occurrenceId={occurrenceId}
        photo={removing}
        online={online}
        onClose={() => setRemoving(null)}
        onDone={() => {
          setRemoving(null);
          onChanged();
        }}
      />

      {viewing ? (
        <PhotoViewer
          uri={viewing.url}
          visible
          onClose={() => setViewing(null)}
          label={exceptionEvidenceAddedByCopy(viewing.uploadedBy.label)}
          // The full-size link failed (it lives an hour): the viewer closes
          // and the photo's row says so, with Try again.
          onError={() => {
            markFailed(viewing.url);
            setViewing(null);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stacked: {
    flexDirection: 'column',
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  rowTextStacked: {
    alignSelf: 'stretch',
    gap: 4,
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  thumb: {
    width: 76,
    height: 76,
    borderRadius: 10,
  },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
  },
});
