import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Camera, Image as ImageIcon, X } from 'lucide-react-native';
import * as React from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_LIMITS_COPY,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_EVIDENCE_OFFLINE_COPY,
  EXCEPTION_EVIDENCE_PRIVACY_COPY,
  EXCEPTION_EVIDENCE_REMOVE_COPY,
  exceptionEvidenceAddedByCopy,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import {
  describeRemoveEvidenceError,
  EVIDENCE_NOTE_TOO_LONG_COPY,
  EVIDENCE_REASON_TOO_LONG_COPY,
  EVIDENCE_REMOVE_OFFLINE_COPY,
  evidenceCapturedAt,
  evidenceTextState,
  removeEvidence,
  type MobileEvidencePhoto,
} from '@/lib/exception-evidence';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import { photoPermissionDenial } from '@/lib/maintenance-request-photos';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

/**
 * The two photo sheets on an exception (F1-4), built like the Acknowledge and
 * Note sheet: a sibling backdrop behind a plain card (sheet-a11y-structure),
 * the live `online` state from the screen, and the reason shown whenever the
 * button is disabled.
 *
 *   - EvidenceAddSheet: Take photo (the camera; the library instead when the
 *     camera is not allowed or missing) or Choose from library, the picked
 *     photos, an optional note, and "Add". It sends nothing itself: the
 *     Photos section uploads, one row per photo, so a failure is shown on
 *     that photo's row with its retry.
 *   - EvidenceRemoveSheet: an optional reason, and "Remove photo". A soft
 *     remove: the photo leaves the list, the timeline records who removed it
 *     and why, and the stored file is kept (owner decision F1 Q7).
 *
 * Both size and scroll like the Acknowledge sheet (R1 walk 2026-09-29, iPhone
 * 17 at AX5): with the keyboard up a fixed-height body pushed the sheet off
 * the top of the screen, title and Close with it, and nothing but the sheet's
 * own buttons put the keyboard away. Now the sheet is never taller than the
 * space above the keyboard (exceptionSheetLayout), the title stops growing at
 * the display ceiling, the focused note is kept in view as the body shrinks,
 * and a drag on the body or a tap on the sheet outside the note puts the
 * keyboard away (lib/use-sheet-keyboard.ts).
 */

/** The title grows with Dynamic Type up to the display ceiling (as the
 *  Acknowledge sheet's does). */
const TITLE_CAP = capTo(16, TYPE_CEILING.display);

/** The note's and the reason's text stop at the input ceiling, as every
 *  bordered input's does (ui/field.tsx), so the empty field fits the body
 *  with the keyboard up at the largest text sizes. */
const NOTE_FONT_CAP = capTo(15, TYPE_CEILING.input);

export interface PickedEvidencePhoto {
  uri: string;
  fileName?: string;
  /** The device's clock when it was taken (evidenceCapturedAt), or null. */
  capturedAt: string | null;
}

/**
 * Add a photo: pick it (camera, or the library), see it, add an optional
 * note, then Add. The pickers open FROM this sheet and the sheet stays until
 * Add, so no sheet is presented or dismissed while a picker is still closing.
 */
export function EvidenceAddSheet({
  visible,
  room,
  online,
  onClose,
  onAdd,
}: {
  visible: boolean;
  /** How many more photos fit (evidenceRoomLeft), for the library's limit. */
  room: number;
  online: boolean;
  onClose: () => void;
  onAdd: (photos: PickedEvidencePhoto[], note: string | null) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Remounted per opening (key), so every opening starts empty. */}
      <AddSheetContent key={String(visible)} room={room} online={online} onClose={onClose} onAdd={onAdd} />
    </Modal>
  );
}

function AddSheetContent({
  room,
  online,
  onClose,
  onAdd,
}: {
  room: number;
  online: boolean;
  onClose: () => void;
  onAdd: (photos: PickedEvidencePhoto[], note: string | null) => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState<PickedEvidencePhoto[]>([]);
  const [picking, setPicking] = React.useState(false);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The height the keyboard-avoiding wrapper leaves, measured; null until
  // the first layout pass.
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({
    windowHeight: height,
    availableHeight,
    topInset: insets.top,
  });
  const [attachBody, kb] = useSheetKeyboard();
  const text = evidenceTextState(note);
  // Offline first: nothing is queued for later (online only, F1 Q6).
  const reason = !online ? EXCEPTION_EVIDENCE_OFFLINE_COPY : text.tooLong ? EVIDENCE_NOTE_TOO_LONG_COPY : null;
  const many = photos.length > 1;
  // Slots left for more picks in this sheet.
  const left = Math.max(0, room - photos.length);

  // One picker at a time: a second tap while one is opening does nothing.
  // Picks add to the ones already here, never past the room left.
  async function pick(run: () => Promise<PickedEvidencePhoto[]>) {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await run();
      if (picked.length > 0) setPhotos((prev) => [...prev, ...picked].slice(0, Math.max(0, room)));
    } finally {
      setPicking(false);
    }
  }

  async function chooseFromLibrary(): Promise<PickedEvidencePhoto[]> {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      const denial = photoPermissionDenial('library', perm.canAskAgain);
      Alert.alert(denial.title, denial.message);
      return [];
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ['images'],
      allowsMultipleSelection: left > 1,
      selectionLimit: Math.max(1, left),
      // Read for the capture time only (evidenceCapturedAt); nothing else
      // from it is sent, and the server strips the file's own metadata.
      exif: true,
    });
    if (result.canceled) return [];
    return result.assets.map((a) => ({
      uri: a.uri,
      fileName: a.fileName ?? undefined,
      capturedAt: evidenceCapturedAt({ source: 'library', exif: a.exif, pickedAt: new Date() }),
    }));
  }

  /** When the camera is not allowed, or there is none (the simulator): the
   *  library instead, offered in the same alert. */
  function offerLibraryInstead(title: string, message: string) {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Choose from library', onPress: () => void pick(chooseFromLibrary) },
    ]);
  }

  async function takePhoto(): Promise<PickedEvidencePhoto[]> {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      const denial = photoPermissionDenial('camera', perm.canAskAgain);
      offerLibraryInstead(denial.title, `${denial.message} You can choose a photo from your library instead.`);
      return [];
    }
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        mediaTypes: ['images'],
        cameraType: ImagePicker.CameraType.back,
        exif: true,
      });
    } catch {
      // The simulator has no camera; launchCameraAsync rejects.
      offerLibraryInstead(
        'Camera unavailable',
        'The camera is not available on this device. You can choose a photo from your library instead.',
      );
      return [];
    }
    const a = result.canceled ? undefined : result.assets[0];
    if (!a) return [];
    return [
      {
        uri: a.uri,
        fileName: a.fileName ?? undefined,
        capturedAt: evidenceCapturedAt({ source: 'camera', exif: a.exif, pickedAt: new Date() }),
      },
    ];
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View
        style={{ flex: 1, justifyContent: 'flex-end' }}
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
      >
        <Pressable
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View
          onStartShouldSetResponder={kb.claimTapOutside}
          onResponderRelease={kb.onTapOutside}
          style={[styles.sheet, { backgroundColor: c.card, maxHeight: layout.sheetMaxHeight }]}
        >
          <View style={styles.header}>
            <Body
              size={16}
              color={c.ink}
              style={{ fontFamily: FONT.display, flex: 1 }}
              accessibilityRole="header"
              maxFontSizeMultiplier={TITLE_CAP}
            >
              Add a photo
            </Body>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.close}
            >
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>

          <ScrollView
            ref={attachBody}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            scrollEventThrottle={16}
            onScroll={kb.onBodyScroll}
            onLayout={kb.onBodyLayout}
            onContentSizeChange={kb.onBodyContentSizeChange}
            contentContainerStyle={{ gap: 12 }}
            style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
          >
            {photos.length > 0 ? (
              <View style={styles.previews}>
                {photos.map((p, i) => (
                  <Image
                    key={`${p.uri}:${i}`}
                    source={{ uri: p.uri }}
                    style={styles.preview}
                    contentFit="cover"
                    accessible
                    accessibilityLabel={many ? `Photo ${i + 1} of ${photos.length} to add` : 'The photo to add'}
                  />
                ))}
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              <Button
                block
                variant="outline"
                leading={<Camera size={16} color={c.ink} strokeWidth={1.5} />}
                disabled={picking || left === 0}
                onPress={() => void pick(takePhoto)}
                accessibilityHint="Opens the camera. If the camera is not allowed, you can choose from your library."
              >
                {photos.length > 0 ? 'Take another photo' : 'Take photo'}
              </Button>
              <Button
                block
                variant="outline"
                leading={<ImageIcon size={16} color={c.ink} strokeWidth={1.5} />}
                disabled={picking || left === 0}
                onPress={() => void pick(chooseFromLibrary)}
              >
                {photos.length > 0 ? 'Add more from library' : 'Choose from library'}
              </Button>
              {left === 0 ? (
                <Body size={13} muted>
                  {EXCEPTION_EVIDENCE_CAP_COPY}
                </Body>
              ) : null}
            </View>
            <View style={{ gap: 6 }} onLayout={kb.onNoteBlockLayout}>
              <FieldLabel>NOTE (OPTIONAL)</FieldLabel>
              <TextInput
                value={note}
                onChangeText={setNote}
                onFocus={kb.onNoteFocus}
                onBlur={kb.onNoteBlur}
                onLayout={kb.onNoteLayout}
                maxFontSizeMultiplier={NOTE_FONT_CAP}
                multiline
                placeholder="What the photo shows"
                placeholderTextColor={c.ink4}
                accessibilityLabel="Note, optional"
                accessibilityHint={many ? 'Saved with each photo' : undefined}
                style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
              />
              <Mono size={11} color={text.tooLong ? ACCENT.crit : c.ink4}>
                {`${text.length.toLocaleString('en-US')} / ${EXCEPTION_EVIDENCE_NOTE_MAX.toLocaleString('en-US')}`}
              </Mono>
              {many ? (
                <Body size={13} muted>
                  The note is saved with each photo.
                </Body>
              ) : null}
            </View>
            <Body size={13} muted>
              {EXCEPTION_EVIDENCE_LIMITS_COPY}
            </Body>
            <Body size={13} muted>
              {EXCEPTION_EVIDENCE_PRIVACY_COPY}
            </Body>
          </ScrollView>

          {reason ? (
            <Body size={13} color={c.ink3} accessibilityRole="text">
              {reason}
            </Body>
          ) : null}

          <Button
            block
            disabled={reason !== null || photos.length === 0 || picking}
            onPress={() => onAdd(photos, note.trim() || null)}
          >
            {many ? `Add ${photos.length} photos` : 'Add photo'}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export function EvidenceRemoveSheet({
  visible,
  occurrenceId,
  photo,
  online,
  onClose,
  onDone,
}: {
  visible: boolean;
  occurrenceId: string;
  photo: MobileEvidencePhoto | null;
  online: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal visible={visible && photo !== null} transparent animationType="slide" onRequestClose={onClose}>
      {photo ? (
        <RemoveSheetContent
          key={photo.id}
          occurrenceId={occurrenceId}
          photo={photo}
          online={online}
          onClose={onClose}
          onDone={onDone}
        />
      ) : null}
    </Modal>
  );
}

function RemoveSheetContent({
  occurrenceId,
  photo,
  online,
  onClose,
  onDone,
}: {
  occurrenceId: string;
  photo: MobileEvidencePhoto;
  online: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The height the keyboard-avoiding wrapper leaves, measured; null until
  // the first layout pass.
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({
    windowHeight: height,
    availableHeight,
    topInset: insets.top,
  });
  const [attachBody, kb] = useSheetKeyboard();
  const text = evidenceTextState(reason);
  const disabledReason = !online
    ? EVIDENCE_REMOVE_OFFLINE_COPY
    : text.tooLong
      ? EVIDENCE_REASON_TOO_LONG_COPY
      : null;

  async function submit() {
    if (disabledReason !== null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await removeEvidence(occurrenceId, photo.id, reason.trim() || null);
      onDone();
    } catch (e) {
      setError(describeRemoveEvidenceError(e));
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View
        style={{ flex: 1, justifyContent: 'flex-end' }}
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
      >
        <Pressable
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View
          onStartShouldSetResponder={kb.claimTapOutside}
          onResponderRelease={kb.onTapOutside}
          style={[styles.sheet, { backgroundColor: c.card, maxHeight: layout.sheetMaxHeight }]}
        >
          <View style={styles.header}>
            <Body
              size={16}
              color={c.ink}
              style={{ fontFamily: FONT.display, flex: 1 }}
              accessibilityRole="header"
              maxFontSizeMultiplier={TITLE_CAP}
            >
              Remove this photo?
            </Body>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.close}
            >
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>

          <ScrollView
            ref={attachBody}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            scrollEventThrottle={16}
            onScroll={kb.onBodyScroll}
            onLayout={kb.onBodyLayout}
            onContentSizeChange={kb.onBodyContentSizeChange}
            contentContainerStyle={{ gap: 12 }}
            style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
          >
            <Image
              source={{ uri: photo.thumbUrl ?? photo.url }}
              style={styles.preview}
              contentFit="cover"
              accessible
              accessibilityLabel={`The photo to remove. ${exceptionEvidenceAddedByCopy(photo.uploadedBy.label)}`}
            />
            <Body size={14}>{EXCEPTION_EVIDENCE_REMOVE_COPY}</Body>
            <View style={{ gap: 6 }} onLayout={kb.onNoteBlockLayout}>
              <FieldLabel>REASON (OPTIONAL)</FieldLabel>
              <TextInput
                value={reason}
                onChangeText={(t) => {
                  setReason(t);
                  setError(null);
                }}
                onFocus={kb.onNoteFocus}
                onBlur={kb.onNoteBlur}
                onLayout={kb.onNoteLayout}
                maxFontSizeMultiplier={NOTE_FONT_CAP}
                multiline
                editable={!submitting}
                placeholder="Why it is being removed"
                placeholderTextColor={c.ink4}
                accessibilityLabel="Reason, optional"
                style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
              />
              <Mono size={11} color={text.tooLong ? ACCENT.crit : c.ink4}>
                {`${text.length.toLocaleString('en-US')} / ${EXCEPTION_EVIDENCE_NOTE_MAX.toLocaleString('en-US')}`}
              </Mono>
            </View>
          </ScrollView>

          {disabledReason ? (
            <Body size={13} color={c.ink3} accessibilityRole="text">
              {disabledReason}
            </Body>
          ) : null}
          {error ? (
            <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
              {error}
            </Body>
          ) : null}

          <Button block disabled={disabledReason !== null || submitting} onPress={() => void submit()}>
            {submitting ? 'Removing...' : 'Remove photo'}
          </Button>
          <Button block variant="outline" onPress={onClose}>
            Keep photo
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 32,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  close: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previews: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  preview: {
    width: 88,
    height: 88,
    borderRadius: 10,
  },
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
