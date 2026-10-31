import { X } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CachedImage } from '@/components/ui/cached-image';
import { Modal } from '@/components/ui/modal';
import { IconChip } from '@/components/ui/row';
import { Mono } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

/**
 * Full-screen photo viewer — a transparent Modal over the page colour of the
 * device's mode, with pinch-zoom via the classic iOS ScrollView zoom
 * (maximumZoomScale + a single viewport-sized child). No new dependencies.
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
 *
 * LOOK (redesign): the viewer follows the device's mode, as every overlay does
 * (DESIGN-SPEC 10: the image lightbox needs both themes). The ground is the
 * page colour, the close button the shared header chip (a 44pt frame around
 * the 38pt card chip, where it was a 36pt circle with hitSlop), and the label
 * sits on a card pill so it reads over any photo. It was a fixed near-black
 * ground with white marks in both modes, under a status bar drawn for the
 * page behind it: in light mode the clock was dark on near-black.
 */
export function PhotoViewer({
  uri,
  visible,
  onClose,
  label,
  onError,
  cacheKey,
}: {
  uri: string;
  visible: boolean;
  onClose: () => void;
  label?: string;
  /** The image could not be loaded (an expired signed link, a missing
   *  file). Without it a failed image stays blank, as before. */
  onError?: () => void;
  /** The disk cache key, when the caller's rule differs from CachedImage's
   *  default (an external cover whose query identifies the picture). */
  cacheKey?: string;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { c } = useTheme();
  // Ref, not state: onScroll fires per frame while pinching, and the only
  // consumer is the tap handler's "am I zoomed" check at press time.
  const zoomedRef = React.useRef(false);

  // The Modal unmounts its children when hidden, so the ScrollView remounts
  // at zoom 1 — but THIS component stays mounted and the ref would remember
  // the old zoom until the first scroll event. Re-sync it on visibility so a
  // close-while-zoomed never leaves backdrop-tap-to-close inert on reopen.
  React.useEffect(() => {
    zoomedRef.current = false;
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: c.paper }}>
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
            <CachedImage
              uri={uri}
              cacheKey={cacheKey}
              style={{ width, height }}
              contentFit="contain"
              onError={onError}
            />
          </Pressable>
        </ScrollView>

        {/* The 44pt frame is centred where the old 36pt circle was (its centre
            28pt below the inset, 34pt from the right edge). */}
        <View style={{ position: 'absolute', top: insets.top + 6, right: 12 }}>
          <IconChip
            icon={X}
            shape="circle"
            onPress={onClose}
            accessibilityLabel="Close photo viewer"
            minTap
          />
        </View>

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
            {/* The name on a card pill with a hairline edge, so it reads over a
                light or a dark photo alike: the secondary ink on the card is
                14.1:1 in light and 12.7:1 in dark. */}
            <View
              style={{
                maxWidth: '100%',
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: c.hair,
                backgroundColor: c.card,
              }}
            >
              <Mono size={11} tracking={0.08} upper color={c.ink2} numberOfLines={2}>
                {label}
              </Mono>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
