import { Check } from 'lucide-react-native';
import * as React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { shouldStackRow } from '../../../../lib/dynamic-type-layout';
import {
  poOutstanding,
  poRunSubtotal,
  poRunSubtotalLabel,
  poSizeLabel,
  type PoRunGroup,
  type PoRunLine,
} from '../../../../lib/po-size-run';
import { TYPE_CEILING, capTo } from '../../../../lib/theme';
import { Pill } from '../../pill';
import { GlassBackdrop } from '../glass-backdrop';
import { GLASS_METRICS } from '../metrics';
import { INPUT_LINE } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

import { SIZES_PER_BLOCK, receivedOf, sizeBlocks, sizeLeft, type DraftReceived } from './po-model';

export { receiptTotals } from './po-model';

/**
 * The PO receive screen in Liquid Glass, from the iOS Receive board
 * (iOS-Receive.dc.html; sp.css line numbers in brackets). Used only inside the
 * screen's `lg` branches; Classic never reaches this file.
 *
 *   nav       Back and Scan as 44pt glass circles, "Receive PO-…" as the
 *             17/600 title between them (.ios-nav [700-701]);
 *   header    the first grouped card: the supplier at 600 with the status
 *             badge, and the board's one line of guidance (.ios-group [708]);
 *   size run  the board's grid (.sr-grid [785-791]): the sizes as columns,
 *             Ordered / Now / Left as rows, Now typed into 44pt wells and
 *             Left in the ok, warn or danger tone; All N as the tinted
 *             capsule;
 *   lines     every other line, history card and the notes as grouped cards;
 *   footer    the floating glass action bar (.item-actions [768]) with the
 *             units entered and what is still to come beside Post receipt.
 *
 * The screen's own recipe (makeStyles) draws everything else in the glass
 * palette and faces through glassRecipe (merge-styles.ts); glassPoShape is
 * the board's shape laid over it, key by key.
 */

/** The board's widths: 16 from the screen's sides, 16 between cards (.ios-scroll [698]). */
const SIDE = 16;
const GAP = 16;

export function glassPoShape(lg: GlassLook) {
  const group: ViewStyle = {
    borderRadius: GLASS_METRICS.group.radius,
    borderWidth: lg.material === 'opaque' ? 0 : StyleSheet.hairlineWidth,
    borderColor: lg.g.cardLine,
    backgroundColor: lg.material === 'opaque' ? lg.ios.card : lg.g.cardFill,
  };
  // A typed box: the field fill with the 3:1 input line (WCAG 1.4.11), radius
  // 12 as .sr-in [789]; the board's well has no edge of its own.
  const field: ViewStyle = {
    backgroundColor: lg.g.fieldFill,
    borderColor: INPUT_LINE[lg.mode],
    borderWidth: 1,
    borderRadius: 12,
  };
  const capsule: ViewStyle = {
    borderRadius: 22,
    borderWidth: 0,
    borderColor: 'transparent',
    backgroundColor: lg.ios.fill,
  };
  const semi = (size: number, color: string): TextStyle => ({
    ...lg.font.displaySemi,
    fontSize: size,
    letterSpacing: 0,
    color,
  });
  return {
    root: { backgroundColor: 'transparent' },
    // .ios-nav [700]: 52 tall, 16 from the sides, 10 between; the chips are
    // 44pt circles in glass, so no 3pt frame offset.
    topbar: {
      height: GLASS_METRICS.nav.height,
      paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
      paddingTop: 0,
      gap: GLASS_METRICS.nav.gap,
      alignItems: 'center',
    },
    lineCard: { ...group, padding: 14, marginBottom: 0 },
    lineCardHighlighted: {
      borderWidth: 2,
      borderColor: lg.g.accent,
      backgroundColor: lg.g.selFill,
    },
    lineName: { ...semi(16, lg.c.ink), lineHeight: 21 },
    lineMeta: { color: lg.c.ink3, fontSize: 12.5, marginTop: 2 },
    lineMetricsRow: { marginTop: 10, gap: 18 },
    // .sr-l [787]: the row words at 12/600 (ink-3: --ios-l2 is under AA on a card).
    metricLabel: {
      ...semi(12, lg.c.ink3),
      textTransform: 'none',
      lineHeight: 16,
    },
    // .sr-v [788]: 16/600 tabular.
    metricValue: {
      ...semi(16, lg.c.ink),
      fontVariant: ['tabular-nums'],
      marginTop: 2,
    },
    metricCaption: { fontSize: 12, color: lg.c.ink3 },
    qtyRow: { marginTop: 12, alignItems: 'flex-end', gap: 10 },
    qtyLabel: { ...semi(13, lg.c.ink3), marginBottom: 6 },
    qtyInput: {
      ...field,
      ...semi(18, lg.c.ink),
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
      minHeight: 44,
    },
    // All: the board's tinted capsule (.ios-capsule, accent wash, 36 drawn; 44 to touch).
    allBtn: {
      ...capsule,
      backgroundColor: lg.g.accentWash,
      minHeight: 44,
      paddingHorizontal: 16,
    },
    allBtnText: semi(15, lg.g.accentText),
    fullyReceived: { ...lg.font.displayRegular, color: lg.g.accentText, fontSize: 14 },
    partNotice: { borderRadius: 16, marginBottom: 0 },
    partRetry: { ...capsule, minHeight: 44, paddingHorizontal: 16 },
    partRetryText: semi(15, lg.c.ink),
    historySection: { marginTop: 0, gap: 8 },
    // .ios-h [706]: 20/25 700 -0.3, 4pt in.
    historyHeading: {
      ...lg.font.displaySemi,
      fontWeight: '700',
      fontSize: 20,
      lineHeight: 25,
      letterSpacing: -0.3,
      textTransform: 'none',
      color: lg.c.ink,
      marginHorizontal: 4,
      marginBottom: 0,
    },
    historyCard: { ...group, padding: 14, marginBottom: 0 },
    historyNumber: { fontSize: 14 },
    // The notes as the board's Notes group: the 13/600 label over the box.
    notesBlock: { ...group, marginTop: 0, padding: 14, paddingHorizontal: SIDE, gap: 6 },
    notesInput: {
      ...lg.font.displayRegular,
      fontWeight: '400',
      fontSize: 16,
      backgroundColor: lg.g.fieldFill,
    },
    attachHint: { marginTop: 0, color: lg.c.ink3 },
    muted: { color: lg.c.ink3 },
    // .item-actions [768]: the floating glass bar, 16 / 16 / 22, 64 tall,
    // radius 32, 7 inside; its material is a GlassBackdrop drawn first.
    footer: {
      left: GLASS_METRICS.actionBar.left,
      right: GLASS_METRICS.actionBar.right,
      bottom: GLASS_METRICS.actionBar.bottom,
      minHeight: GLASS_METRICS.actionBar.height,
      borderRadius: GLASS_METRICS.actionBar.radius,
      padding: 0,
      paddingHorizontal: GLASS_METRICS.actionBar.paddingHorizontal,
      paddingVertical: 7,
      flexDirection: 'row',
      alignItems: 'center',
      gap: GLASS_METRICS.actionBar.gap,
      borderTopWidth: 0,
      backgroundColor: 'transparent',
    },
  } satisfies Record<string, ViewStyle | TextStyle>;
}

/** The ScrollView's content in glass: 16 from the sides, 16 between cards, clear of the bar. */
export const GLASS_PO_SCROLL: ViewStyle = {
  paddingHorizontal: SIDE,
  paddingTop: 4,
  paddingBottom: 140,
  gap: GAP,
};

/** The nav title (.ios-nav .ttl [701]): 17/600, centred between the circles. */
export function GlassPoNavTitle({ lg, title }: { lg: GlassLook; title: string }) {
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      maxFontSizeMultiplier={capTo(17, TYPE_CEILING.chrome)}
      style={[
        lg.font.displaySemi,
        { flex: 1, textAlign: 'center', fontSize: 17, letterSpacing: -0.4, color: lg.c.ink },
      ]}
    >
      {title}
    </Text>
  );
}

/** Keeps the title centred when the nav has no right-hand circle. */
export function GlassNavSpacer() {
  return <View style={{ width: GLASS_METRICS.circle.size, height: GLASS_METRICS.circle.size }} />;
}

/**
 * The board's first card: the supplier at 600 with the status as a badge, and
 * its line of guidance while there is something to receive. The PO number is
 * the nav's title above it.
 */
export function GlassPoHeaderGroup({
  lg,
  supplier,
  status,
  guidance,
}: {
  lg: GlassLook;
  supplier: string;
  status: string;
  guidance: boolean;
}) {
  return (
    <View style={[groupStyle(lg), { paddingVertical: 14, paddingHorizontal: SIDE, gap: 6 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          style={[
            lg.font.displaySemi,
            { flex: 1, fontSize: 16, lineHeight: 21, letterSpacing: 0, color: lg.c.ink },
          ]}
        >
          {supplier}
        </Text>
        <Pill dot={false}>{status}</Pill>
      </View>
      {guidance ? (
        <Text
          style={[
            lg.font.displayRegular,
            { fontSize: 13, lineHeight: 18, letterSpacing: 0, color: lg.c.ink2 },
          ]}
        >
          Enter how many you received for each line. Receiving in parts is fine: post a receipt each
          time more arrives.
        </Text>
      ) : null}
    </View>
  );
}

function groupStyle(lg: GlassLook): ViewStyle {
  const opaque = lg.material === 'opaque';
  return {
    borderRadius: GLASS_METRICS.group.radius,
    borderWidth: opaque ? 0 : StyleSheet.hairlineWidth,
    borderColor: lg.g.cardLine,
    backgroundColor: opaque ? lg.ios.card : lg.g.cardFill,
  };
}

/**
 * One size run in the board's grid. The quantities are the screen's own draft
 * (controlled boxes, the same onChangeReceived and All as Classic), so nothing
 * typed is held here. At the larger text sizes the grid would crush its
 * columns, so it draws one row per size instead (the Classic order: size,
 * ordered and received, the box), still in glass.
 */
export function GlassSizeRunCard<L extends PoRunLine>({
  lg,
  group,
  lines,
  draft,
  highlightLineId,
  onChangeReceived,
  onReceiveAll,
}: {
  lg: GlassLook;
  group: PoRunGroup;
  lines: readonly L[];
  draft: DraftReceived;
  highlightLineId: string | null;
  onChangeReceived: (lineId: string, value: string) => void;
  onReceiveAll: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const stacked = shouldStackRow(fontScale);
  const received = receivedOf(lines, draft);
  const subtotal = poRunSubtotal(lines, received);
  const totalOrdered = lines.reduce((s, l) => s + l.quantity_ordered, 0);
  const outstanding = lines.reduce((s, l) => s + poOutstanding(l), 0);
  const anyReceivedBefore = lines.some((l) => l.quantity_received > 0);
  const t = textStyles(lg);

  return (
    <View style={[groupStyle(lg), { padding: 14, gap: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={t.runName} numberOfLines={2}>
            {group.name}
          </Text>
          <Text style={t.runMeta}>
            Size run · {lines.length} sizes · {totalOrdered} ordered
          </Text>
        </View>
        {outstanding > 0 ? (
          <Pressable
            onPress={onReceiveAll}
            accessibilityRole="button"
            accessibilityLabel={`All ${outstanding}`}
            style={({ pressed }) => [t.allCapsule, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}
          >
            <Text style={t.allText} maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}>
              All {outstanding}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {stacked
        ? lines.map((l) => (
            <StackedSizeRow
              key={l.id}
              lg={lg}
              line={l}
              value={received[l.id] ?? ''}
              highlighted={highlightLineId === l.id}
              onChange={(v) => onChangeReceived(l.id, v)}
            />
          ))
        : sizeBlocks(lines).map((block) => (
            <View
              key={block[0]!.id}
              accessibilityLabel={`Size run ${group.name}`}
              style={{ gap: 6 }}
            >
              <View style={t.gridRow}>
                <View style={t.gridLabelCell} />
                {block.map((l) => (
                  <Text key={l.id} style={[t.gridCell, t.sizeHead]} numberOfLines={1}>
                    {poSizeLabel(l.variantSize)}
                  </Text>
                ))}
                {padCells(block.length)}
              </View>
              <View style={t.gridRow}>
                <Text style={[t.gridLabelCell, t.rowLabel]}>Ordered</Text>
                {block.map((l) => (
                  <Text key={l.id} style={[t.gridCell, t.value]}>
                    {l.quantity_ordered || '—'}
                  </Text>
                ))}
                {padCells(block.length)}
              </View>
              {anyReceivedBefore ? (
                <View style={t.gridRow}>
                  <Text style={[t.gridLabelCell, t.rowLabel]}>Received</Text>
                  {block.map((l) => (
                    <Text key={l.id} style={[t.gridCell, t.value, { color: lg.c.ink3 }]}>
                      {l.quantity_received}
                    </Text>
                  ))}
                  {padCells(block.length)}
                </View>
              ) : null}
              <View style={t.gridRow}>
                <Text style={[t.gridLabelCell, t.rowLabel]}>Now</Text>
                {block.map((l) => {
                  const full = poOutstanding(l) === 0;
                  const highlighted = highlightLineId === l.id;
                  return (
                    <View key={l.id} style={t.gridCell}>
                      {full ? (
                        <View
                          style={t.fullCell}
                          accessible
                          accessibilityLabel={`Size ${poSizeLabel(l.variantSize)}: full`}
                        >
                          <Check size={16} color={lg.g.accentText} strokeWidth={2} />
                        </View>
                      ) : (
                        <TextInput
                          value={received[l.id] ?? ''}
                          onChangeText={(v) => onChangeReceived(l.id, v)}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={lg.c.ink3}
                          maxFontSizeMultiplier={capTo(18, TYPE_CEILING.control)}
                          style={[t.well, highlighted && t.wellHighlighted]}
                          accessibilityLabel={`Receiving size ${poSizeLabel(l.variantSize)}`}
                        />
                      )}
                    </View>
                  );
                })}
                {padCells(block.length)}
              </View>
              <View style={t.gridRow}>
                <Text style={[t.gridLabelCell, t.rowLabel]}>Left</Text>
                {block.map((l) => {
                  const left = sizeLeft(l, received[l.id]);
                  return (
                    <Text
                      key={l.id}
                      style={[t.gridCell, t.value, { color: toneColour(lg, left.tone) }]}
                    >
                      {left.text}
                    </Text>
                  );
                })}
                {padCells(block.length)}
              </View>
            </View>
          ))}

      <Text style={t.subtotal}>{poRunSubtotalLabel(subtotal, group.countingUnit)}</Text>
    </View>
  );
}

/** Empty cells so a short last block keeps the five columns' widths. */
function padCells(n: number) {
  const out: React.ReactNode[] = [];
  for (let i = n; i < SIZES_PER_BLOCK; i += 1)
    out.push(<View key={`pad-${i}`} style={GRID.cell} />);
  return out;
}

function StackedSizeRow({
  lg,
  line,
  value,
  highlighted,
  onChange,
}: {
  lg: GlassLook;
  line: PoRunLine;
  value: string;
  highlighted: boolean;
  onChange: (v: string) => void;
}) {
  const t = textStyles(lg);
  const full = poOutstanding(line) === 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Text style={[t.sizeHead, { minWidth: 56, textAlign: 'left' }]}>
        {poSizeLabel(line.variantSize)}
      </Text>
      <Text style={[t.rowLabel, { flex: 1, minWidth: 0 }]}>
        {line.quantity_ordered} ord · {line.quantity_received} rec
      </Text>
      {full ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Check size={14} color={lg.g.accentText} strokeWidth={2} />
          <Text style={t.fullText}>Full</Text>
        </View>
      ) : (
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={lg.c.ink3}
          style={[
            t.well,
            { minWidth: 96, textAlign: 'right', paddingHorizontal: 12 },
            highlighted && t.wellHighlighted,
          ]}
          accessibilityLabel={`Receiving size ${poSizeLabel(line.variantSize)}`}
        />
      )}
    </View>
  );
}

function toneColour(lg: GlassLook, tone: 'ok' | 'warn' | 'danger'): string {
  return tone === 'ok' ? lg.g.ok : tone === 'warn' ? lg.g.warn : lg.g.danger;
}

const GRID = StyleSheet.create({
  // .sr-grid [785]: a 64pt label column, then five equal columns, 6 apart.
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { width: 64 },
  cell: { flex: 1, minWidth: 0, alignItems: 'stretch' },
});

const textMemo = new WeakMap<GlassLook, ReturnType<typeof buildText>>();
function textStyles(lg: GlassLook) {
  let hit = textMemo.get(lg);
  if (!hit) {
    hit = buildText(lg);
    textMemo.set(lg, hit);
  }
  return hit;
}

function buildText(lg: GlassLook) {
  const semi = (size: number, color: string): TextStyle => ({
    ...lg.font.displaySemi,
    fontSize: size,
    letterSpacing: 0,
    color,
  });
  return StyleSheet.create({
    runName: { ...semi(16, lg.c.ink), lineHeight: 21 },
    runMeta: { ...lg.font.displayRegular, fontSize: 13, lineHeight: 17, color: lg.c.ink3 },
    allCapsule: {
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: 22,
      backgroundColor: lg.g.accentWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    allText: semi(15, lg.g.accentText),
    gridRow: GRID.row,
    gridLabelCell: GRID.label,
    gridCell: { ...GRID.cell, textAlign: 'center' },
    // .sr-h [786]: the size heads 13/700 ink-2, centred.
    sizeHead: { ...semi(13, lg.c.ink2), fontWeight: '700', textAlign: 'center' },
    // .sr-l [787]: 12/600 (ink-3 for AA).
    rowLabel: { ...semi(12, lg.c.ink3) },
    // .sr-v [788]: 16/600 tabular, centred.
    value: { ...semi(16, lg.c.ink), fontVariant: ['tabular-nums'], textAlign: 'center' },
    // .sr-in [789-790]: 44 tall, radius 12, 18/700 tabular, centred; the
    // field fill with the 3:1 input line.
    well: {
      ...semi(18, lg.c.ink),
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
      textAlign: 'center',
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: INPUT_LINE[lg.mode],
      backgroundColor: lg.g.fieldFill,
      paddingHorizontal: 2,
      paddingVertical: 0,
    },
    // The size a scan just filled: the accent edge (.sr-in:focus [790]).
    wellHighlighted: { borderWidth: 2, borderColor: lg.g.accent },
    fullCell: {
      minHeight: 44,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: lg.g.accentWash,
    },
    fullText: semi(13, lg.g.accentText),
    subtotal: {
      ...semi(13, lg.c.ink),
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: lg.g.line2,
    },
  });
}

/**
 * The left of the floating bar (.item-actions [768]): the units this receipt
 * takes, and what is still to come after it. Read only from the screen's own
 * lines and draft; the board's destination name is not loaded by this screen,
 * so it is left out.
 */
export function GlassReceiptSummary({
  lg,
  units,
  stillToCome,
}: {
  lg: GlassLook;
  units: number;
  stillToCome: number;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${units} ${units === 1 ? 'unit' : 'units'}, ${stillToCome} still to come`}
      style={{ flex: 1, minWidth: 0, paddingLeft: 10 }}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={capTo(16, TYPE_CEILING.control)}
        style={[
          lg.font.displaySemi,
          {
            fontWeight: '700',
            fontSize: 16,
            letterSpacing: 0,
            color: lg.c.ink,
            fontVariant: ['tabular-nums'],
          },
        ]}
      >
        {units} {units === 1 ? 'unit' : 'units'}
      </Text>
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={capTo(12, TYPE_CEILING.control)}
        style={[
          lg.font.displayRegular,
          { fontSize: 12, lineHeight: 16, letterSpacing: 0, color: lg.c.ink3 },
        ]}
      >
        {stillToCome} still to come
      </Text>
    </View>
  );
}

/** The floating bar's material, drawn first under the bar's own words and button. */
export function GlassActionBarBackdrop() {
  return <GlassBackdrop variant="floating" radius={GLASS_METRICS.actionBar.radius} />;
}
