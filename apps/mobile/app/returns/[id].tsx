import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReturnWorkbenchView } from '@/components/return-workbench-view';
import { IconChip } from '@/components/ui/row';
import { SceneBackground } from '@/components/ui/glass/scene-background';
import { GLASS_LIST } from '@/components/ui/glass/screens/list';
import { useGlass } from '@/components/ui/glass/use-glass';
import { useTheme } from '@/lib/use-theme';

/**
 * One RMA on the phone (returns RX-1): the workbench (src/components/
 * return-workbench-view.tsx) under a back chip. Reached from the Returns
 * list, the order screen's returns section, and the staff push (the dual
 * link /dashboard/returns/<rma>?order=… rewritten to /returns/<rma>, or the
 * cold-start shim app/dashboard/returns/[id].tsx).
 */
export default function ReturnScreen() {
  const { c } = useTheme();
  // Liquid Glass: the scene behind the workbench and Back in the glass nav.
  const lg = useGlass();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/returns');
  };
  return (
    <View style={[styles.root, { backgroundColor: lg ? 'transparent' : c.paper }]}>
      {lg ? <SceneBackground /> : null}
      <SafeAreaView edges={['top']} style={{ backgroundColor: lg ? 'transparent' : c.paper }}>
        <View style={lg ? GLASS_LIST.nav : styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
        </View>
      </SafeAreaView>
      {id ? <ReturnWorkbenchView returnId={id} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 12, paddingTop: 5, flexDirection: 'row', alignItems: 'center', marginLeft: -3 },
});
