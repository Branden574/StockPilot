import { Fingerprint, ScanFace } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  useAnimatedValue,
} from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { useColdLaunchGate } from '@/lib/cold-launch-gate';
import { getBiometricCapability, type BiometricCapability } from '@/lib/biometric';
import { useProfile } from '@/lib/use-profile';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Full-screen biometric lock — auto-prompts on mount when the device is
 * capable, with a "Try again" button and a "Use password" escape hatch.
 * Brand-themed warm-paper / ink-black, large line-art biometric icon
 * with a subtle pulse ring behind it.
 */
export function BiometricLockScreen() {
  const { unlock, signOutToFallback } = useAuth();
  const profile = useProfile();
  const { c } = useTheme();
  // While the cold-launch splash is still on screen, defer the Face-ID
  // auto-prompt so the system scan doesn't run BEHIND the splash. Released at
  // hand-off. False (no gate) on a warm re-lock, preserving prior behavior.
  const { splashActive } = useColdLaunchGate();
  const [busy, setBusy] = React.useState(false);
  const [cap, setCap] = React.useState<BiometricCapability | null>(null);
  const [attempted, setAttempted] = React.useState(false);
  const [failedOnce, setFailedOnce] = React.useState(false);

  // Subtle pulse ring behind the biometric glyph
  const pulse = useAnimatedValue(0);
  React.useEffect(() => {
    Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2400,
        easing: Easing.bezier(0.16, 1, 0.3, 1),
        useNativeDriver: true,
      }),
    ).start();
  }, [pulse]);
  const pulseScale = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.92, 1.18, 1.18] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.9, 0, 0] });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const probed = await getBiometricCapability();
      if (!cancelled) setCap(probed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tryUnlock = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setAttempted(true);
    const ok = await unlock();
    setBusy(false);
    if (!ok) setFailedOnce(true);
  }, [busy, unlock]);

  React.useEffect(() => {
    if (splashActive) return; // wait for the cold-launch splash to hand off
    if (!cap) return;
    if (!cap.hasHardware || !cap.isEnrolled) return;
    if (attempted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- biometric auto-prompt: the sync busy/attempted sets latch the one-shot OS Face-ID prompt (the external system this effect drives); the unlock verdict lands post-await
    void tryUnlock();
  }, [cap, attempted, tryUnlock, splashActive]);

  const isFingerprint = cap?.label === 'Fingerprint';
  const Icon = isFingerprint ? Fingerprint : ScanFace;
  const labelText = cap?.label ?? 'Biometric';

  return (
    <AuthShell>
      <View style={{ marginTop: 18 }}>
        <Eyebrow>UNLOCK STOCKPILOT</Eyebrow>
      </View>

      <View style={styles.center}>
        <Avatar size={56} />
        <View style={{ alignItems: 'center', gap: 4, marginTop: 16 }}>
          <Body size={14} color={c.ink3}>
            Signed in as
          </Body>
          <Body size={16} color={c.ink} style={{ fontFamily: FONT.display }}>
            {profile.email ?? 'StockPilot'}
          </Body>
        </View>

        <View style={styles.iconWell}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.pulseRing,
              {
                borderColor: c.hair,
                transform: [{ scale: pulseScale }],
                opacity: pulseOpacity,
              },
            ]}
          />
          {busy ? (
            <ActivityIndicator size="large" color={c.ink} />
          ) : (
            <Icon size={96} color={c.ink} strokeWidth={1.2} />
          )}
          <View style={[styles.pip, { backgroundColor: ACCENT.pipTeal }]} />
        </View>

        <Display size={26} style={{ textAlign: 'center', maxWidth: 280, marginTop: 8 }}>
          {failedOnce
            ? <>That didn&apos;t verify. <Em>Try again.</Em></>
            : cap && (!cap.hasHardware || !cap.isEnrolled)
              ? <>Use your <Em>password</Em> to continue.</>
              : <>Look at your screen to <Em>unlock.</Em></>}
        </Display>
      </View>

      <View style={styles.footer}>
        {cap && cap.hasHardware && cap.isEnrolled ? (
          <Button
            block
            onPress={tryUnlock}
            disabled={busy}
            leading={<Icon size={18} color={c.paper} strokeWidth={1.6} />}
          >
            Unlock with {labelText}
          </Button>
        ) : null}
        <Button block variant="ghost" onPress={signOutToFallback}>
          Use password instead
        </Button>
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  iconWell: {
    width: 152,
    height: 152,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginTop: 12,
  },
  pulseRing: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    left: 8,
    right: 8,
    borderRadius: 76,
    borderWidth: 1,
  },
  pip: {
    position: 'absolute',
    top: 12,
    right: 14,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  footer: {
    paddingBottom: 30,
    gap: 10,
  },
});
