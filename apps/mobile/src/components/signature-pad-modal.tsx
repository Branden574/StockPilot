import { StatusBar } from 'expo-status-bar';
import { X } from 'lucide-react-native';
import React, { useRef, useState } from 'react';
import { Alert, Keyboard, Modal, PanResponder, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Path, Rect, Svg } from 'react-native-svg';
import { type SignaturePoint, isValidSignatureDataUrl, pointsToSmoothSvgPath } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Mono } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';
import { api } from '../lib/api';

interface SignaturePadModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  signatureToken: string;
  defaultName?: string;
  defaultEmail?: string;
}

const PAD_HEIGHT = 200;
// Screen chrome: 20px horizontal page padding on each side (styles.container).
const PAD_H_MARGIN = 40;
const PAD_MIN_WIDTH = 280;
const PAD_MAX_WIDTH = 560;

/**
 * The packing-slip signature pad (Scan tab and the order screen), in the
 * device's mode: the page, the words, the text boxes and the buttons follow
 * the per-mode palette, and the modal sets its own status bar so the clock
 * reads on its page in both modes. The capture surface does NOT follow the
 * mode: it stays white with near-black strokes (17.40:1), because the stored
 * PNG prints on the packing slip and shows on the web, both on white.
 *
 * Kept exactly: every word, the required name, email and drawn signature, the
 * re-entry guard, the PanResponder that holds the whole stroke (the pad sits
 * in a plain, non-scrolling View) and drops the keyboard on the first stroke,
 * and the pad's width rule. Save Signature is the ink button (it commits the
 * signature), Clear the outline beside it; Close is a named 44pt button.
 */
export function SignaturePadModal({
  visible,
  onClose,
  onSuccess,
  signatureToken,
  defaultName = '',
  defaultEmail = '',
}: SignaturePadModalProps) {
  const { c, mode } = useTheme();
  // Fill the available width (up to a cap) so tablets and large phones get a
  // proportionate pad instead of a fixed 320px box floating in the middle.
  const { width: windowWidth } = useWindowDimensions();
  const padWidth = Math.max(PAD_MIN_WIDTH, Math.min(PAD_MAX_WIDTH, windowWidth - PAD_H_MARGIN));
  const [signerName, setSignerName] = useState(defaultName);
  const [signerEmail, setSignerEmail] = useState(defaultEmail);
  const [strokes, setStrokes] = useState<SignaturePoint[][]>([]);
  const [currentStroke, setCurrentStroke] = useState<SignaturePoint[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const svgRef = useRef<any>(null);

  // Lazy useState, not useRef(...).current: reading .current during render
  // is a compiler violation; the responder is create-once and every handler
  // uses functional setState, so nothing here goes stale.
  const [panResponder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Hold the gesture for the entire stroke so nothing (an ancestor, the OS
      // scroll/keyboard handling) can reinterpret the drag as a scroll and yank
      // the pad away. The pad now lives in a plain non-scrolling View, but be
      // explicit so this can't regress.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        // Drop the keyboard the instant signing starts so the full pad shows.
        Keyboard.dismiss();
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentStroke([{ x: locationX, y: locationY }]);
      },
      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentStroke((prev) => [...prev, { x: locationX, y: locationY }]);
      },
      onPanResponderRelease: () => {
        setCurrentStroke((prev) => {
          if (prev.length > 0) {
            setStrokes((s) => [...s, prev]);
          }
          return [];
        });
      },
    }),
  );

  const handleClear = () => {
    setStrokes([]);
    setCurrentStroke([]);
  };

  const handleSave = () => {
    if (submitting) return; // re-entry guard: ignore taps while a submit is in flight
    if (!signerName.trim()) {
      Alert.alert('Required', 'Please enter your name.');
      return;
    }
    if (!signerEmail.trim()) {
      Alert.alert('Required', 'Please enter your email.');
      return;
    }
    if (strokes.length === 0 && currentStroke.length === 0) {
      Alert.alert('Signature required', 'Please draw your signature before saving.');
      return;
    }
    if (!svgRef.current) {
      Alert.alert('Error', 'Signature pad not ready. Please try again.');
      return;
    }

    // Disable the button BEFORE the async toDataURL callback fires — otherwise a
    // fast double-tap during the capture+network gap would POST the same
    // signature token twice (the server rejects the replay, but the user would
    // see a confusing error). finally clears it on every exit path.
    setSubmitting(true);
    svgRef.current.toDataURL(async (base64: string) => {
      try {
        const signatureDataUrl = 'data:image/png;base64,' + base64;
        if (!isValidSignatureDataUrl(signatureDataUrl)) {
          Alert.alert('Error', 'Failed to capture signature. Please try again.');
          return;
        }
        // Use the /api/v1 alias so the request is covered by the Vercel
        // Firewall bypass for /api/v1* — the bare /api/orders/sign path gets
        // bot-challenged and 429s the app. Same handler server-side.
        await api('/api/v1/orders/sign', {
          method: 'POST',
          body: {
            token: signatureToken,
            signerName: signerName.trim(),
            signerEmail: signerEmail.trim(),
            signatureDataUrl,
          },
        });
        // Reset local state while still mounted, then notify parent + close.
        handleClear();
        setSignerName(defaultName);
        setSignerEmail(defaultEmail);
        onSuccess();
        onClose();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Failed to save signature. Please try again.';
        Alert.alert('Error', message);
      } finally {
        setSubmitting(false);
      }
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView
          style={[styles.container, { backgroundColor: c.paper }]}
          edges={['top', 'bottom']}
        >
          {/* The modal's own status bar: dark words on the light page, light
              words on the dark one (it was the host's: white on a light page
              in dark mode, about 1.05:1). Mounted only while the pad shows,
              so closing it hands the bar back to the screen underneath. */}
          <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
          <View style={styles.header}>
            <Display size={24} accessibilityRole="header" style={styles.title}>
              Sign Order
            </Display>
            {/* The chip's 44pt frame is 3pt wider than the chip on each side:
                it takes 3pt back so the X sits on the page's edge. */}
            <View style={styles.close}>
              <IconChip icon={X} onPress={onClose} accessibilityLabel="Close" minTap />
            </View>
          </View>

          <View style={styles.form}>
            {/* The shared text box. Named for VoiceOver by its label's words
                (the placeholder is still read while it is empty); typed words
                grow with the text size as before (0: React Native's no-limit
                sentinel, which the shared box honours). */}
            <Field
              label="Full Name *"
              value={signerName}
              onChangeText={setSignerName}
              placeholder="Your full name"
              autoCapitalize="words"
              returnKeyType="next"
              accessibilityLabel="Full Name"
              maxFontSizeMultiplier={0}
            />
            <Field
              label="Email *"
              value={signerEmail}
              onChangeText={setSignerEmail}
              placeholder="your@email.com"
              keyboardType="email-address"
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
              accessibilityLabel="Email"
              maxFontSizeMultiplier={0}
            />
          </View>

          <Mono size={10} tracking={0.12} upper color={c.ink3} style={styles.padLabel}>
            Signature *
          </Mono>
          <View style={[styles.padWrapper, { borderColor: c.hair2 }]}>
            <Svg
              ref={svgRef}
              width={padWidth}
              height={PAD_HEIGHT}
              style={styles.svg}
              {...panResponder.panHandlers}
            >
              <Rect x={0} y={0} width={padWidth} height={PAD_HEIGHT} fill="white" />
              {strokes.map((stroke, i) => (
                <Path
                  key={i}
                  d={pointsToSmoothSvgPath(stroke)}
                  stroke="#1a1a1a"
                  strokeWidth={2}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {currentStroke.length > 0 && (
                <Path
                  d={pointsToSmoothSvgPath(currentStroke)}
                  stroke="#1a1a1a"
                  strokeWidth={2}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </Svg>
          </View>
          <Body size={12.5} color={c.ink3} style={styles.padHint}>
            Draw your signature above
          </Body>

          <View style={styles.actions}>
            <Button variant="outline" onPress={handleClear} style={styles.clearBtn}>
              Clear
            </Button>
            <Button onPress={() => void handleSave()} disabled={submitting} style={styles.saveBtn}>
              {submitting ? 'Saving…' : 'Save Signature'}
            </Button>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingVertical: 8 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  title: { flexShrink: 1 },
  close: { marginRight: -3 },
  form: { gap: 14, marginBottom: 16 },
  padLabel: { marginBottom: 6 },
  // The frame around the white capture surface: the per-mode stronger border.
  padWrapper: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  // White in both modes: the stored signature prints on white.
  svg: { backgroundColor: '#fff' },
  padHint: { textAlign: 'center', marginTop: 4, marginBottom: 16 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  clearBtn: { flex: 1 },
  saveBtn: { flex: 2 },
});
