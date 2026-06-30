import React, { useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Path, Rect, Svg } from 'react-native-svg';
import { type SignaturePoint, isValidSignatureDataUrl, pointsToSvgPath } from '@stockpilot/core';
import { api } from '../lib/api';

interface SignaturePadModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  signatureToken: string;
  defaultName?: string;
  defaultEmail?: string;
}

const PAD_WIDTH = 320;
const PAD_HEIGHT = 200;

export function SignaturePadModal({
  visible,
  onClose,
  onSuccess,
  signatureToken,
  defaultName = '',
  defaultEmail = '',
}: SignaturePadModalProps) {
  const [signerName, setSignerName] = useState(defaultName);
  const [signerEmail, setSignerEmail] = useState(defaultEmail);
  const [strokes, setStrokes] = useState<SignaturePoint[][]>([]);
  const [currentStroke, setCurrentStroke] = useState<SignaturePoint[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const svgRef = useRef<any>(null);

  const panResponder = useRef(
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
  ).current;

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
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>Sign Order</Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.closeBtn}>✕</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Full Name *</Text>
          <TextInput
            style={styles.input}
            value={signerName}
            onChangeText={setSignerName}
            placeholder="Your full name"
            autoCapitalize="words"
            returnKeyType="next"
          />
          <Text style={styles.label}>Email *</Text>
          <TextInput
            style={styles.input}
            value={signerEmail}
            onChangeText={setSignerEmail}
            placeholder="your@email.com"
            keyboardType="email-address"
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
        </View>

        <Text style={styles.label}>Signature *</Text>
        <View style={styles.padWrapper}>
          <Svg
            ref={svgRef}
            width={PAD_WIDTH}
            height={PAD_HEIGHT}
            style={styles.svg}
            {...panResponder.panHandlers}
          >
            <Rect x={0} y={0} width={PAD_WIDTH} height={PAD_HEIGHT} fill="white" />
            {strokes.map((stroke, i) => (
              <Path
                key={i}
                d={pointsToSvgPath(stroke)}
                stroke="#1a1a1a"
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {currentStroke.length > 0 && (
              <Path
                d={pointsToSvgPath(currentStroke)}
                stroke="#1a1a1a"
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </Svg>
        </View>
        <Text style={styles.padHint}>Draw your signature above</Text>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.saveBtn, submitting && styles.saveBtnDisabled]}
            onPress={() => void handleSave()}
            disabled={submitting}
          >
            <Text style={styles.saveBtnText}>{submitting ? 'Saving…' : 'Save Signature'}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa', paddingHorizontal: 20, paddingVertical: 8 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#111' },
  closeBtn: { fontSize: 18, color: '#666' },
  form: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#fff',
    color: '#111',
  },
  padWrapper: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  svg: { backgroundColor: '#fff' },
  padHint: { fontSize: 12, color: '#999', textAlign: 'center', marginTop: 4, marginBottom: 16 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  clearBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  clearBtnText: { fontSize: 16, color: '#555', fontWeight: '600' },
  saveBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: '#2563eb',
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { fontSize: 16, color: '#fff', fontWeight: '700' },
});
