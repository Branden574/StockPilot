import { useNetworkState } from 'expo-network';
import { Check, ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { isOfflineState } from '@/lib/exceptions-api';
import { FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { setActiveOrg, setActiveWarehouse, useWorkspace } from '@/lib/use-workspace';

/**
 * Drawer-header workspace chip + bottom-sheet picker.
 *
 * The chip shows the active org and warehouse. Tapping it opens a sheet
 * with two sections:
 *   • ORGANIZATIONS — one row per accepted membership; tap to switch
 *     org. The warehouse list under it then re-loads for the new org
 *     and any persisted active warehouse for that org is restored.
 *   • WAREHOUSES — one row per warehouse the user can read in the
 *     active org, plus a leading "All warehouses" option (null id).
 *
 * Selections persist via AsyncStorage in `use-workspace.ts` — no
 * round-trip to Supabase is needed when re-opening the app.
 *
 * Drawn on the per-mode palette as the reference's org switcher and sheets:
 * the chip a card with the stronger control border, the sheet a card over the
 * app's scrim, each option row a 44pt target with the stronger border, the
 * chosen one on the recessed fill with an ink edge and a tick.
 */
export function WorkspaceHeaderChip({ onPress }: { onPress: () => void }) {
  const { c } = useTheme();
  const { activeOrgName, activeWarehouseName, loading, orgs } = useWorkspace();
  if (loading || orgs.length === 0) return null;
  const orgLabel = activeOrgName ?? 'Workspace';
  const warehouseLabel = activeWarehouseName ?? 'All warehouses';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: c.hair2, backgroundColor: c.card, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel="Switch workspace"
      // The label names the action; the value says which workspace is on,
      // which VoiceOver could not hear before (the label hid the chip's words).
      accessibilityValue={{ text: `${orgLabel}, ${warehouseLabel}` }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono size={9.5} tracking={0.16} upper color={c.ink3}>
          WORKSPACE
        </Mono>
        <Body size={13} color={c.ink} style={{ fontFamily: FONT.display, marginTop: 2 }}>
          {orgLabel}
        </Body>
        <Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 2 }}>
          {warehouseLabel}
        </Mono>
      </View>
      <ChevronDown size={14} color={c.ink3} strokeWidth={1.6} />
    </Pressable>
  );
}

/** Under ORGANIZATIONS while offline, when the rows cannot be tapped. */
export const WORKSPACE_SWITCH_OFFLINE_COPY =
  "Switching organization needs a connection. It replaces this phone's offline copy of your items, " +
  'purchase orders and counts, and the new one cannot load until you are back online.';

export function WorkspaceSwitcherSheet({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const { c, mode } = useTheme();
  const { orgs, activeOrgId, warehouses, activeWarehouseId } = useWorkspace();
  // A switch of organization clears this phone's offline copy of the old one
  // (items, purchase orders, counts) and pulls the new one in full. Offline
  // the pull cannot start, so a tap, even by mistake, left no offline copy of
  // either until the phone was back online (review 2026-09-26). Organizations
  // are not switchable while offline; warehouses are (nothing is cleared).
  // The live network state, the rule sync.ts isOnline() applies.
  const offline = isOfflineState(useNetworkState());
  /** An option row: the chosen one recessed with an ink edge, the rest outlined. */
  const optionStyle = (selected: boolean) => ({
    borderColor: selected ? c.ink : c.hair2,
    backgroundColor: selected ? c.sunk : 'transparent',
  });
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      {/*
       * The app's sheet shape (biometric-optin-sheet.tsx): the scrim is a
       * SIBLING behind the card, a "Close" button that a VoiceOver double-tap
       * closes directly (onAccessibilityTap; iOS would otherwise tap the
       * scrim's centre, which this tall card covers), and the container keeps
       * VoiceOver inside the sheet and closes it on the escape scrub.
       */}
      <View style={styles.container} accessibilityViewIsModal onAccessibilityEscape={onDismiss}>
        <Pressable
          onPress={onDismiss}
          onAccessibilityTap={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
        />
        <View style={[styles.sheet, { backgroundColor: c.card, borderColor: c.hair }]}>
          <View style={[styles.grabber, { backgroundColor: c.ink5 }]} />
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24 }}
          >
            <Eyebrow>SWITCH</Eyebrow>
            <Display size={22} style={{ marginTop: 8 }}>
              Pick a <Em>workspace.</Em>
            </Display>

            <View style={{ marginTop: 18 }}>
              <Eyebrow>ORGANIZATIONS</Eyebrow>
              {offline && orgs.length > 1 ? (
                <Body size={12.5} muted style={{ marginTop: 8 }}>
                  {WORKSPACE_SWITCH_OFFLINE_COPY}
                </Body>
              ) : null}
              <View style={{ marginTop: 8, gap: 8 }}>
                {orgs.map((o) => {
                  const selected = activeOrgId === o.id;
                  return (
                    <Pressable
                      key={o.id}
                      onPress={() => {
                        if (!offline) void setActiveOrg(o.id);
                      }}
                      disabled={offline}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: offline }}
                      style={({ pressed }) => [
                        styles.row,
                        optionStyle(selected),
                        { opacity: offline && !selected ? 0.5 : pressed ? 0.8 : 1 },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
                          {o.name}
                        </Body>
                        <Mono size={10.5} tracking={0.06} color={c.ink3} style={{ marginTop: 2 }}>
                          {o.role.toUpperCase()}
                        </Mono>
                      </View>
                      {selected ? <Check size={15} color={c.ink} strokeWidth={2} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {activeOrgId ? (
              <View style={{ marginTop: 22 }}>
                <Eyebrow>WAREHOUSES</Eyebrow>
                <View style={{ marginTop: 8, gap: 8 }}>
                  <Pressable
                    onPress={() => {
                      void setActiveWarehouse(null);
                      onDismiss();
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: activeWarehouseId === null }}
                    style={({ pressed }) => [
                      styles.row,
                      optionStyle(activeWarehouseId === null),
                      { opacity: pressed ? 0.8 : 1 },
                    ]}
                  >
                    <Body size={14} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
                      All warehouses
                    </Body>
                    {activeWarehouseId === null ? (
                      <Check size={15} color={c.ink} strokeWidth={2} />
                    ) : null}
                  </Pressable>
                  {warehouses.map((w) => {
                    const selected = activeWarehouseId === w.id;
                    return (
                      <Pressable
                        key={w.id}
                        onPress={() => {
                          void setActiveWarehouse(w.id);
                          onDismiss();
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        style={({ pressed }) => [
                          styles.row,
                          optionStyle(selected),
                          { opacity: pressed ? 0.8 : 1 },
                        ]}
                      >
                        <Body size={14} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
                          {w.name}
                        </Body>
                        {selected ? <Check size={15} color={c.ink} strokeWidth={2} /> : null}
                      </Pressable>
                    );
                  })}
                  {warehouses.length === 0 ? (
                    <Body size={12.5} muted>
                      No warehouses in this org yet.
                    </Body>
                  ) : null}
                </View>
              </View>
            ) : null}

            <View style={{ marginTop: 16 }}>
              <Button variant="ghost" block onPress={onDismiss}>
                Done
              </Button>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: RADIUS.card,
  },
  // The bottom-anchored container the card sits in, over the full-screen scrim.
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '85%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 14,
  },
  // minHeight, not a fixed height: a 44pt target that grows with its words.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderWidth: 1,
    borderRadius: RADIUS.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
});
