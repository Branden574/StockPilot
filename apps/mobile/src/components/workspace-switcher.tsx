import { Check, ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import {
  setActiveOrg,
  setActiveWarehouse,
  useWorkspace,
} from '@/lib/use-workspace';

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
 */
export function WorkspaceHeaderChip({ onPress }: { onPress: () => void }) {
  const { c } = useTheme();
  const { activeOrgName, activeWarehouseName, loading, orgs } = useWorkspace();
  if (loading || orgs.length === 0) return null;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: c.hair, backgroundColor: c.card, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel="Switch workspace"
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono size={9.5} tracking={0.16} upper color={c.ink4}>
          WORKSPACE
        </Mono>
        <Body
          size={13}
          color={c.ink}
          style={{ fontFamily: FONT.display, marginTop: 2 }}
        >
          {activeOrgName ?? 'Workspace'}
        </Body>
        <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
          {activeWarehouseName ?? 'All warehouses'}
        </Mono>
      </View>
      <ChevronDown size={14} color={c.ink3} strokeWidth={1.6} />
    </Pressable>
  );
}

export function WorkspaceSwitcherSheet({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const { c } = useTheme();
  const { orgs, activeOrgId, warehouses, activeWarehouseId } = useWorkspace();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss} />
      <View style={[styles.sheet, { backgroundColor: c.paper, borderColor: c.hair }]}>
        <View style={styles.grabber} />
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
            <View style={{ marginTop: 8, gap: 8 }}>
              {orgs.map((o) => {
                const selected = activeOrgId === o.id;
                return (
                  <Pressable
                    key={o.id}
                    onPress={() => void setActiveOrg(o.id)}
                    style={({ pressed }) => [
                      styles.row,
                      {
                        borderColor: selected ? c.ink : c.hair,
                        backgroundColor: selected ? c.card : 'transparent',
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
                        {o.name}
                      </Body>
                      <Mono size={10.5} tracking={0.06} color={c.ink4} style={{ marginTop: 2 }}>
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
                  style={({ pressed }) => [
                    styles.row,
                    {
                      borderColor: activeWarehouseId === null ? c.ink : c.hair,
                      backgroundColor: activeWarehouseId === null ? c.card : 'transparent',
                      opacity: pressed ? 0.8 : 1,
                    },
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
                      style={({ pressed }) => [
                        styles.row,
                        {
                          borderColor: selected ? c.ink : c.hair,
                          backgroundColor: selected ? c.card : 'transparent',
                          opacity: pressed ? 0.8 : 1,
                        },
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
                  <Mono size={11} tracking={0.04} color={c.ink4}>
                    No warehouses in this org yet.
                  </Mono>
                ) : null}
              </View>
            </View>
          ) : null}

          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.done, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Mono size={13} tracking={0.04} color={c.ink3} style={{ fontFamily: FONT.display }}>
              Done
            </Mono>
          </Pressable>
        </ScrollView>
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
    borderRadius: 12,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
    backgroundColor: '#ccc',
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  done: {
    marginTop: 16,
    alignSelf: 'center',
    padding: 10,
  },
});
