import { X } from 'lucide-react-native';
import * as React from 'react';
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CachedImage } from '@/components/ui/cached-image';
import { Mono } from '@/components/ui/text';

/**
 * Full-screen photo viewer — a transparent Modal over a near-black backdrop
 * with pinch-zoom via the classic iOS ScrollView zoom (maximumZoomScale +
 * a single viewport-sized child). No new dependencies.
 *
 * The image goes in as the master signed URL via CachedImage, so the viewer
 * hits the same disk cache entry the list rows and the detail hero already
 * warmed — it renders instantly, no second download.
 *
 * Closing: the X (top-right, safe-area aware) always works. A plain tap on
 * the image/backdrop also closes, but ONLY while not zoomed — the tap target
 * is a Pressable child of the zoom ScrollView, which coexists cleanly with
 * pinch/pan: a drag or pinch makes the ScrollView claim the responder and
 * cancel the press, so only a genuine stationary tap fires. While zoomed,
 * taps are ignored so a mis-tap mid-inspection doesn't dismiss the photo
 * (zoom state is read from onScroll's zoomScale, kept in a ref — it must not
 * re-render per scroll frame).
 *
 * ANDROID NOTE: ScrollView pinch-zoom (maximumZoomScale/bouncesZoom) is
 * iOS-only. Android is parked; when it unparks this component needs a
 * gesture-handler pass for pinch support (do NOT add
 * react-native-gesture-handler until then).
 *
 * PARITY NOTE: order proof tiles and future maintenance-request photos on
 * mobile can reuse this component — same contract, master URL straight in.
 */
export function PhotoViewer({
  uri,
  visible,
  onClose,
  label,
}: {
  uri: string;
  visible: boolean;
  onClose: () => void;
  label?: string;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Ref, not state: onScroll fires per frame while pinching, and the only
  // consumer is the tap handler's "am I zoomed" check at press time.
  const zoomedRef = React.useRef(false);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(8,8,8,0.97)' }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ width, height }}
          maximumZoomScale={4}
          minimumZoomScale={1}
          bouncesZoom
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => {
            zoomedRef.current = e.nativeEvent.zoomScale > 1.02;
          }}
        >
          <Pressable
            onPress={() => {
              if (!zoomedRef.current) onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel="Photo — tap to close"
            style={{ width, height }}
          >
            <CachedImage uri={uri} style={{ width, height }} contentFit="contain" />
          </Pressable>
        </ScrollView>

        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close photo viewer"
          style={({ pressed }) => ({
            position: 'absolute',
            top: insets.top + 10,
            right: 16,
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: 'rgba(255,255,255,0.14)',
            justifyContent: 'center',
            alignItems: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <X size={19} color="#fff" strokeWidth={1.8} />
        </Pressable>

        {label ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 20,
              right: 20,
              bottom: insets.bottom + 16,
              alignItems: 'center',
            }}
          >
            <Mono size={11} tracking={0.08} upper color="rgba(255,255,255,0.72)" numberOfLines={2}>
              {label}
            </Mono>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
