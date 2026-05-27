import { Fingerprint, ScanFace } from 'lucide-react-native';
import * as React from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { getBiometricCapability, type BiometricCapability } from '@/lib/biometric';
import { ACCENT, FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Post-sign-in opt-in sheet. Renders as a native iOS-style bottom sheet
 * with a grabber on iOS, or a Material 3 bottom sheet on Android.
 * Eyebrow + display title with a serif-italic emphasis on the biometric
 * name (Face ID / Touch ID / Fingerprint).
 */
export function BiometricOptInSheet({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const { enableBiometric } = useAuth();
  const { c, mode } = useTheme();
  const [cap, setCap] = React.useState<BiometricCapability | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      const probed = await getBiometricCapability();
      if (!cancelled) setCap(probed);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  React.useEffect(() => {
    if (!visible || !cap) return;
    if (!cap.hasHardware || !cap.isEnrolled) onDismiss();
  }, [cap, onDismiss, visible]);

  if (!cap) return null;

  async function handleEnable() {
    if (busy) return;
    setBusy(true);
    await enableBiometric();
    setBusy(false);
    onDismiss();
  }

  const isFingerprint = cap.label === 'Fingerprint';
  const Icon = isFingerprint ? Fingerprint : ScanFace;
  const labelText = cap.label;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <Pressable
        style={[
          styles.scrim,
          { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
        ]}
        onPress={onDismiss}
      >
        <Pressable
          onPress={() => undefined}
          style={[
            styles.sheet,
            {
              backgroundColor: c.card,
              paddingTop: Platform.OS === 'ios' ? 12 : 20,
              paddingBottom: Platform.OS === 'ios' ? 36 : 28,
            },
            SHADOW.sheet,
          ]}
        >
          {Platform.OS === 'ios' ? (
            <View style={styles.grabberRow}>
              <View
                style={[
                  styles.grabber,
                  {
                    backgroundColor:
                      mode === 'dark'
                        ? 'rgba(250,250,247,0.22)'
                        : 'rgba(14,15,13,0.18)',
                  },
                ]}
              />
            </View>
          ) : null}

          <Eyebrow>ONE-TAP SIGN-IN</Eyebrow>
          <Display size={28} style={{ marginTop: 14, maxWidth: 320 }}>
            Use <Em>{labelText}</Em> next time?
          </Display>
          <Body muted style={{ marginTop: 12 }}>
            Unlock StockPilot faster and skip typing your password on this device. You can turn it off any time in{' '}
            <Mono size={12.5} color={c.ink}>Settings · Security</Mono>.
          </Body>

          <View style={styles.iconWrap}>
            <Icon size={64} color={c.ink} strokeWidth={1.3} />
            <View style={[styles.pip, { backgroundColor: ACCENT.pipAmber }]} />
          </View>

          <View style={{ gap: 10 }}>
            <Button
              block
              disabled={busy}
              onPress={handleEnable}
              leading={<Icon size={18} color={c.paper} strokeWidth={1.6} />}
            >
              Enable {labelText}
            </Button>
            <Button block variant="ghost" onPress={onDismiss}>
              Not now
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 22,
  },
  grabberRow: {
    alignItems: 'center',
    marginBottom: 18,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 100,
  },
  iconWrap: {
    marginTop: 24,
    marginBottom: 18,
    paddingVertical: 20,
    alignItems: 'center',
    position: 'relative',
  },
  pip: {
    position: 'absolute',
    top: 28,
    right: '35%',
    width: 5,
    height: 5,
    borderRadius: 3,
  },
});
