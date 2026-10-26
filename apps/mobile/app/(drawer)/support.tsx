import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { ArrowLeft, Camera, ImageIcon, LifeBuoy, Menu, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import { PHOTO_BACKGROUND } from '@/components/ui/tones';
import { api } from '@/lib/api';
import { resizeForUpload } from '@/lib/image-resize';
import { goBackFromReturn } from '@/lib/return-path';
import { supabase } from '@/lib/supabase';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Support & feedback — mobile twin of the web /dashboard/support form.
 * Submits to POST /api/v1/support (Bearer). An optional screenshot is uploaded
 * to the private support-attachments bucket under `${userId}/…` (mig 0260
 * storage policy) and only its path is sent; identity comes from the session
 * server-side.
 *
 * Reached by link only (the rewrite of /dashboard/support: What's New, a
 * notification), as before. Its top bar is now the other screens' bar: Back
 * (a `?return=` path inside the app, else back, else Home: goBackFromReturn)
 * and the menu, both named for VoiceOver (redesign defect D28: no Back, and a
 * menu with no name).
 */
const CATEGORIES = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'billing', label: 'Billing' },
  { value: 'other', label: 'Other' },
] as const;
type Category = (typeof CATEGORIES)[number]['value'];

export default function SupportScreen() {
  const { c } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const { return: returnPath } = useLocalSearchParams<{ return?: string }>();
  const goBack = () => goBackFromReturn(router, returnPath);

  const [category, setCategory] = React.useState<Category>('bug');
  const [subject, setSubject] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [attachment, setAttachment] = React.useState<{ uri: string; path: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function uploadScreenshot(asset: ImagePicker.ImagePickerAsset) {
    setUploading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        Alert.alert('Not signed in', 'Please sign in again and retry.');
        return;
      }
      // Transcode/resize FIRST — every other mobile upload path does, and this
      // one skipping it was a real defect: expo-image-picker 17 (SDK 56) flipped
      // preferredAssetRepresentationMode, so an iOS library pick now hands back
      // HEIC. The old code derived contentType from the extension with a ternary
      // that falls through to 'image/jpeg' for anything not png/webp, so a .heic
      // pick was stored as HEIC bytes LABELLED image/jpeg — a support screenshot
      // no browser can render, arriving at the team as a broken image. Verified
      // in prod on 2026-08-11: support-attachments held `…heic` at
      // mimetype image/jpeg.
      //
      // resizeForUpload transcodes any non-web-safe format to JPEG (including on
      // its already-small fast path) and reports the real extension, so the
      // label and the bytes now always agree.
      const resized = await resizeForUpload(asset.uri);
      // RN gotcha: bytes MUST come from fetch(uri).arrayBuffer() — blob()
      // uploads 0 bytes (same as po-attachments).
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const ext = resized.ext;
      const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const rand = Math.random().toString(36).slice(2, 14);
      // Bucket policy (mig 0260) only allows uploads under the caller's own uid.
      const path = `${user.id}/${rand}.${ext}`;
      const { error } = await supabase.storage
        .from('support-attachments')
        .upload(path, arrayBuffer, { contentType });
      if (error) {
        Alert.alert('Upload failed', error.message);
        return;
      }
      // Preview the TRANSCODED file, not the original: on iOS the picked HEIC
      // renders locally but is not what we stored, and showing the source while
      // uploading the conversion would hide a transcode failure from the person
      // attaching it.
      setAttachment({ uri: resized.uri, path });
    } finally {
      setUploading(false);
    }
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera permission needed', 'Enable camera access in Settings to attach a photo.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });
    if (!res.canceled && res.assets[0]) await uploadScreenshot(res.assets[0]);
  }

  async function pickImage() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });
    if (!res.canceled && res.assets[0]) await uploadScreenshot(res.assets[0]);
  }

  function removeAttachment() {
    if (attachment) {
      // Best-effort cleanup; the ticket just won't reference it if this fails.
      void supabase.storage.from('support-attachments').remove([attachment.path]);
    }
    setAttachment(null);
  }

  async function submit() {
    if (subject.trim().length < 3) {
      Alert.alert('Add a subject', 'Give your request a short subject (at least 3 characters).');
      return;
    }
    if (message.trim().length < 10) {
      Alert.alert('Tell us a little more', 'Add a bit more detail (at least 10 characters).');
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/v1/support', {
        method: 'POST',
        body: {
          category,
          subject: subject.trim(),
          message: message.trim(),
          ...(attachment ? { attachmentPath: attachment.path } : {}),
        },
      });
      setSent(true);
      setSubject('');
      setMessage('');
      setAttachment(null);
    } catch (e) {
      Alert.alert('Could not send', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }} edges={['top']}>
      <View style={[styles.topbar, { borderBottomColor: c.hair }]}>
        <View style={styles.chips}>
          <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
          <IconChip
            icon={Menu}
            onPress={() => (navigation as { openDrawer?: () => void }).openDrawer?.()}
            accessibilityLabel="Open menu"
            minTap
          />
        </View>
        <View style={styles.topbarTitle}>
          <LifeBuoy size={16} color={c.ink3} />
          <Body color={c.ink2} style={{ flexShrink: 1 }}>Support &amp; feedback</Body>
        </View>
        {/* Balances the two chips, so the title stays centred. */}
        <View style={styles.chipsSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <Eyebrow>WE READ EVERYTHING</Eyebrow>
        <Display color={c.ink} style={{ marginTop: 4 }}>
          How can we <Em>help?</Em>
        </Display>
        <Body color={c.ink3} style={{ marginTop: 8 }}>
          Report a bug, request a feature, or ask a question. Attach a screenshot if it helps — it
          goes straight to the StockPilot team.
        </Body>

        {sent ? (
          <Card style={{ marginTop: 20, padding: 20 }}>
            <Body color={c.ink}>Thanks — we got it.</Body>
            <Body color={c.ink3} style={{ marginTop: 6 }}>
              Our team will follow up by email. You can send another any time.
            </Body>
            <View style={{ marginTop: 16 }}>
              <Button variant="outline" onPress={() => setSent(false)}>
                Send another
              </Button>
            </View>
          </Card>
        ) : (
          <Card style={{ marginTop: 20, padding: 16, gap: 16 }}>
            <View>
              <Eyebrow style={{ marginBottom: 2 }}>CATEGORY</Eyebrow>
              {/* The reference's choice chips in 44pt frames, each a button
                  that says whether it is the chosen category. */}
              <View style={styles.chipRow}>
                {CATEGORIES.map((cat) => {
                  const selected = category === cat.value;
                  return (
                    <Pressable
                      key={cat.value}
                      onPress={() => setCategory(cat.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={({ pressed }) => [styles.chipFrame, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <View
                        style={[
                          styles.chip,
                          selected
                            ? { backgroundColor: c.ink, borderColor: c.ink }
                            : { backgroundColor: 'transparent', borderColor: c.hair2 },
                        ]}
                      >
                        <Text
                          style={[styles.chipLabel, { color: selected ? c.paper : c.ink2 }]}
                          maxFontSizeMultiplier={CHIP_CAP}
                        >
                          {cat.label}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <Field
              label="Subject"
              value={subject}
              onChangeText={setSubject}
              placeholder="Short summary"
              maxLength={140}
            />
            <Field
              label="Details"
              value={message}
              onChangeText={setMessage}
              placeholder="What happened, and what did you expect?"
              multiline
              numberOfLines={5}
              maxLength={4000}
            />

            <View>
              <Eyebrow style={{ marginBottom: 8 }}>SCREENSHOT (OPTIONAL)</Eyebrow>
              {attachment ? (
                <View style={[styles.attachRow, { borderColor: c.hair }]}>
                  {/* The photo ground: white with a hairline in both modes. */}
                  <Image
                    source={{ uri: attachment.uri }}
                    style={[styles.thumb, { backgroundColor: PHOTO_BACKGROUND, borderColor: c.hair }]}
                  />
                  <Body color={c.ink3} style={{ flex: 1 }}>Screenshot attached</Body>
                  {/* A named 44pt button (it was a nameless X with hitSlop). */}
                  <Pressable
                    onPress={removeAttachment}
                    accessibilityRole="button"
                    accessibilityLabel="Remove screenshot"
                    style={styles.removeFrame}
                  >
                    <X size={18} color={c.ink3} />
                  </Pressable>
                </View>
              ) : (
                <View style={styles.pillRow}>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={takePhoto}
                    disabled={uploading}
                    leading={<Camera size={15} color={c.ink2} />}
                  >
                    Camera
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={pickImage}
                    disabled={uploading}
                    leading={<ImageIcon size={15} color={c.ink2} />}
                  >
                    Photos
                  </Button>
                  {uploading ? <ActivityIndicator color={c.ink3} /> : null}
                </View>
              )}
            </View>

            <Button block onPress={submit} disabled={submitting || uploading}>
              {submitting ? 'Sending…' : 'Send to StockPilot'}
            </Button>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A choice chip's label is a control's: the control ceiling. */
const CHIP_CAP = capTo(13, TYPE_CEILING.control);

const styles = StyleSheet.create({
  // The other screens' bar: the chips' 44pt frames are 3pt wider than the
  // 38pt chips, so the bar's padding is 9 (12 less 3) and 5 on top (8 less
  // 3). minHeight, not height: the title is uncapped Body between the chips
  // and the spacer, and it wraps at accessibility sizes.
  topbar: {
    minHeight: 52,
    paddingHorizontal: 9,
    paddingTop: 5,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  // Two 44pt frames and the 2pt gap between them.
  chipsSpacer: { width: 90 },
  topbarTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 },
  // The 44pt target; the 32pt chip sits in its middle.
  chipFrame: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  chip: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: { fontFamily: FONT.displayRegular, fontSize: 13 },
  attachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 8,
  },
  thumb: { width: 44, height: 44, borderRadius: 6, borderWidth: 1 },
  removeFrame: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
