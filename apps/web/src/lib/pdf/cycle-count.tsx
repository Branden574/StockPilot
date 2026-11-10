import { Document, Page, Text, View } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import { capCountSheetLines } from './count-sheet-cap';
import { breakIdentifierLines, breakOverwideWords } from './identifier-lines';
import { cycleCountScopeLabel, formatCycleCountNumber } from '@stockpilot/core';

import { PDF_COLORS, formatDateForPdf, pdfStyles } from './styles';

export interface CycleCountPdfLine {
  sku: string;
  name: string;
  unitOfMeasure: string;
  /** Optional bin / location label. Free-form. */
  location: string | null;
  expectedQuantity: number;
  /** Set on completed sheets so the PDF can render variance directly. */
  countedQuantity?: number | null;
  /** The product group this line's variant belongs to, when it has one.
   *  Null for every item in a non-sports org — those sheets render exactly
   *  as they did before, with no group headers at all. */
  groupId?: string | null;
  /** Display name of that group ("Nike Pegasus 41"). */
  groupName?: string | null;
  /** The variant this line is: "Size 10", "#12 · Size XL". */
  variantLabel?: string | null;
}

/** One printed block: a product group's variants, or the ungrouped remainder. */
interface CountSheetGroup {
  key: string;
  /** Null = the ungrouped block, which prints with no header. */
  name: string | null;
  lines: CycleCountPdfLine[];
  expectedSubtotal: number;
  countedSubtotal: number | null;
  /** The unit the subtotal is IN. Never converted — 'pair' means pairs. */
  unit: string;
}

/**
 * Bucket a sorted line list into printed blocks, one per product group, with
 * the ungrouped remainder LAST.
 *
 * Why grouping is a print concern: a size run is six rows whose only visible
 * difference is a hex SKU. Printed flat, a counter tallies 41 pairs across six
 * lines and has no way to check that against "the Pegasus shelf". A per-group
 * subtotal is the check.
 *
 * The subtotal is DERIVED here from the lines on this sheet and is not a group
 * total — product groups own no quantity, ever. A count that only covers three
 * of a group's six sizes subtotals those three, which is exactly right for a
 * count sheet.
 *
 * Returns a SINGLE unnamed block when nothing on the sheet has a group, so a
 * non-sports count sheet is byte-for-byte the sheet it has always been.
 *
 * Exported for unit testing — this is the part that has to be right.
 */
export function groupCountSheetLines(
  lines: readonly CycleCountPdfLine[],
): CountSheetGroup[] {
  const hasAnyGroup = lines.some((l) => l.groupId);
  if (!hasAnyGroup) {
    return [
      {
        key: '__ungrouped',
        name: null,
        lines: [...lines],
        expectedSubtotal: lines.reduce((a, l) => a + l.expectedQuantity, 0),
        countedSubtotal: subtotalCounted(lines),
        unit: dominantUnit(lines),
      },
    ];
  }

  const byKey = new Map<string, CycleCountPdfLine[]>();
  for (const l of lines) {
    // Bucket on the group ID, never the name: two groups can legitimately
    // share a display name (different seasons, different colourways), and
    // merging them would print one subtotal for two products.
    const key = l.groupId ?? '__ungrouped';
    const bucket = byKey.get(key);
    if (bucket) bucket.push(l);
    else byKey.set(key, [l]);
  }

  const blocks: CountSheetGroup[] = [];
  for (const [key, groupLines] of byKey) {
    if (key === '__ungrouped') continue; // appended last, below
    blocks.push({
      key,
      name: groupLines.find((l) => l.groupName)?.groupName ?? 'Product group',
      lines: groupLines,
      expectedSubtotal: groupLines.reduce((a, l) => a + l.expectedQuantity, 0),
      countedSubtotal: subtotalCounted(groupLines),
      unit: dominantUnit(groupLines),
    });
  }
  blocks.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const ungrouped = byKey.get('__ungrouped');
  if (ungrouped && ungrouped.length > 0) {
    blocks.push({
      key: '__ungrouped',
      name: 'Ungrouped items',
      lines: ungrouped,
      expectedSubtotal: ungrouped.reduce((a, l) => a + l.expectedQuantity, 0),
      countedSubtotal: subtotalCounted(ungrouped),
      unit: dominantUnit(ungrouped),
    });
  }
  return blocks;
}

/** Σ counted over the lines that HAVE a count; null when none do (an
 *  uncounted block must print a blank, never a misleading 0). */
function subtotalCounted(lines: readonly CycleCountPdfLine[]): number | null {
  let sum = 0;
  let any = false;
  for (const l of lines) {
    if (l.countedQuantity == null) continue;
    any = true;
    sum += l.countedQuantity;
  }
  return any ? sum : null;
}

/**
 * The unit a subtotal is printed in: the most common unit_of_measure on the
 * block's lines. PAIR is a display convention with NO conversion behind it, so
 * a block is never re-expressed in another unit — and a mixed block says so
 * rather than picking a winner silently.
 */
function dominantUnit(lines: readonly CycleCountPdfLine[]): string {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const u = (l.unitOfMeasure || '').trim();
    if (!u) continue;
    counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  if (counts.size > 1) return 'units (mixed)';
  return [...counts.keys()][0] as string;
}

export interface CycleCountPdfHeader {
  id: string;
  /** Permanent reference number (0358), printed as CC-000042. */
  countNumber?: number | null;
  /** The header warehouse id and the count's scope decide the scope label
   *  ("All warehouses" only for a real org-wide count). */
  warehouseId?: string | null;
  scope?: string | null;
  warehouseName: string | null;
  notes: string | null;
  startedAt: string | null;
  status: string;
  /** Workspace timezone for the printed start date. */
  timeZone?: string;
}

export interface CycleCountPdfOrg {
  name: string;
  logoUrl: string | null;
}

interface CycleCountSheetPdfProps {
  cycle: CycleCountPdfHeader;
  lines: CycleCountPdfLine[];
  org: CycleCountPdfOrg;
}

const CC_COLS = {
  num: 5,
  sku: 18,
  name: 31,
  loc: 14,
  sysQty: 9,
  countQty: 11,
  notes: 12,
} as const;
const CC_SHARE_TOTAL = Object.values(CC_COLS).reduce((a, b) => a + b, 0);

/**
 * White space between one column's text and the next, in points per CC_COLS
 * share: SKU 4.5pt, Description 7.75pt, Location 3.5pt (plus the room the
 * centred System number leaves). The row cells were bare flex <Text>s and
 * tCell has no side padding, so a long title filled each line up to the exact
 * x where the Location text starts and printed as "...five Bright-door".
 *
 * Why per share: Yoga sizes a flex cell as its padding plus its share of the
 * space left after every cell's padding. When EVERY cell in the row is padded
 * in proportion to its share, that works out to the same width each column
 * always had, so no column moves on any sheet; only the text inside each cell
 * stops short of the next column. (A flat 6pt on three cells shifted every
 * column by up to 5pt; wrapping each cell's text in its own View cost 30% more
 * render time on a 1,000-line sheet.) So every cell in an item row takes
 * ccCell().
 */
const CC_GUTTER_PER_SHARE = 0.25;
export function ccCell(share: number, textAlign: 'left' | 'center' = 'left') {
  const gutter = share * CC_GUTTER_PER_SHARE;
  // A centred cell splits its gutter across both sides so its centre stays.
  return textAlign === 'center'
    ? { flex: share, textAlign, paddingHorizontal: gutter / 2 }
    : { flex: share, paddingRight: gutter };
}

/** pdfStyles.tCell and pdfStyles.tCellMono (styles.ts). */
export const CC_BODY_FONT_PT = 9;
export const CC_SKU_FONT_PT = 8.5;

/**
 * The width a column's text wraps in, in points, so a word too wide for it can
 * be broken before react-pdf paints it over the next column. A LETTER row is
 * 612pt, less the page's 40pt and the row's 4pt padding a side: 524pt. On the
 * count sheet the Counted and Notes write-in lines take 2pt margins a side
 * (8pt) before the CC_COLS shares are split; the variance report's columns are
 * a little wider, so this budgets both on the narrower count sheet.
 */
const CC_ROW_INNER_PT = 612 - 2 * 40 - 2 * 4;
export function ccTextWidthPt(share: number): number {
  return ((CC_ROW_INNER_PT - 2 * 2 * 2) * share) / CC_SHARE_TOTAL - share * CC_GUTTER_PER_SHARE;
}

/**
 * A row moves to the next page whole rather than splitting, which left its
 * write-in lines as a blank strip at the top of the next page, away from the
 * item. A row taller than a page cannot move anywhere, and react-pdf would
 * then print it past the page bottom, so a row with more text than this in
 * its cells may still split. 400 characters of ordinary text is under 35
 * lines even in the narrow Location column (about 12 characters a line),
 * about half a page.
 */
const CC_KEEP_ROW_TOGETHER_MAX_CHARS = 400;

export function CycleCountSheetPdf({
  cycle,
  lines,
  org,
}: CycleCountSheetPdfProps) {
  const reference = formatCycleCountNumber(cycle.countNumber);
  // Status pivots PDF behavior: 'in_progress' renders a printable count
  // sheet with blank Counted/Notes columns; everything else (completed,
  // canceled) renders a variance report so the printed artifact matches
  // the on-screen state. This kills hunter finding #22: closed counts
  // used to dump a blank sheet that didn't match reality.
  const isVarianceReport = cycle.status !== 'in_progress';
  const subtitle =
    [
      // Before 0358's warehouseId/scope were passed, a null warehouse always
      // printed "All warehouses", which misdescribed a mixed selection.
      cycle.warehouseId === undefined && cycle.scope === undefined
        ? (cycle.warehouseName ?? 'All warehouses')
        : cycleCountScopeLabel({
            warehouseId: cycle.warehouseId ?? null,
            warehouseName: cycle.warehouseName,
            scope: cycle.scope ?? null,
          }),
      formatDateForPdf(cycle.startedAt, cycle.timeZone),
      isVarianceReport ? 'Variance report' : null,
    ]
      .filter(Boolean)
      .join(' · ');

  // The count's permanent reference. Without one (a database before 0358)
  // the title says so plainly rather than printing a uuid fragment that
  // reads like a reference.
  const title = reference
    ? isVarianceReport
      ? `Cycle count variance ${reference}`
      : `Cycle count ${reference}`
    : isVarianceReport
      ? 'Cycle count variance report'
      : 'Cycle count sheet';

  // Pre-sort: SKU for count sheets so the printed list matches a
  // shelf-walk pass; variance-magnitude descending for variance
  // reports so the biggest discrepancies show first.
  const sortedLines = [...lines].sort((a, b) => {
    if (isVarianceReport) {
      const va = Math.abs((a.countedQuantity ?? a.expectedQuantity) - a.expectedQuantity);
      const vb = Math.abs((b.countedQuantity ?? b.expectedQuantity) - b.expectedQuantity);
      if (vb !== va) return vb - va;
    }
    return (a.sku ?? '').localeCompare(b.sku ?? '');
  });

  // DISCLOSED render cap (PDF_MAX_LINES): react-pdf builds the whole document
  // in memory, so an unbounded line set is an OOM/timeout, not a big PDF.
  // Applied AFTER the sort so the rendered prefix is the sheet's first N
  // (SKU order / biggest variances). ≤ cap renders the full sheet unchanged;
  // over the cap, `capBanner` discloses the cut on the first page below.
  const { lines: renderLines, banner: capBanner } = capCountSheetLines(sortedLines);

  // Bucket into product-group blocks AFTER the cap, so the printed sheet's
  // subtotals always describe the rows actually on it.
  const blocks = groupCountSheetLines(renderLines);
  // A single unnamed block = nothing on this sheet is grouped. Render the flat
  // sheet exactly as before: no headers, no subtotals, no new ink.
  const showGroupBlocks = blocks.length > 1 || blocks[0]?.name != null;
  // Running sheet-wide row number, so "#" stays a single sequence across
  // blocks rather than restarting per group.
  let rowNumber = 0;

  return (
    <Document title={title}>
      <Page size="LETTER" style={pdfStyles.page}>
        <BrandedHeader
          orgName={org.name}
          orgLogoUrl={org.logoUrl}
          title={title}
          subtitle={subtitle}
          documentDate={new Date()}
        />

        {/* Truncation disclosure — first page, above everything else, so a
            capped sheet can never pass as complete coverage. */}
        {capBanner ? (
          <View
            style={{
              marginBottom: 14,
              paddingVertical: 8,
              paddingHorizontal: 10,
              backgroundColor: PDF_COLORS.bgSunk,
              borderWidth: 1,
              borderColor: PDF_COLORS.lineStrong,
              borderStyle: 'solid',
            }}
            wrap={false}
          >
            <Text style={[pdfStyles.bold, { fontSize: 9, color: PDF_COLORS.ink }]}>
              {capBanner}
            </Text>
          </View>
        ) : null}

        {cycle.notes ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Notes</Text>
            <Text style={pdfStyles.muted}>{cycle.notes}</Text>
          </View>
        ) : null}

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>
            {isVarianceReport ? 'Counted lines' : 'Items to count'} · {sortedLines.length}
          </Text>
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tHeadRow} fixed>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.num }]}>#</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.sku }]}>SKU</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.name }]}>Description</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.loc }]}>Location</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.sysQty, textAlign: 'center' }]}>
                System
              </Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.countQty, textAlign: 'center' }]}>
                Counted
              </Text>
              <Text
                style={[
                  pdfStyles.tHeadCell,
                  { flex: CC_COLS.notes, textAlign: isVarianceReport ? 'center' : 'left' },
                ]}
              >
                {isVarianceReport ? 'Variance' : 'Notes'}
              </Text>
            </View>
            {renderLines.length === 0 ? (
              <View style={pdfStyles.tRow}>
                <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: 1 }]}>
                  No items in this cycle count.
                </Text>
              </View>
            ) : (
              blocks.map((block) => (
                <View key={block.key}>
                  {showGroupBlocks && block.name ? (
                    <View
                      style={[
                        pdfStyles.tRow,
                        { backgroundColor: PDF_COLORS.bgSunk, minHeight: 20 },
                      ]}
                      wrap={false}
                    >
                      <Text style={[pdfStyles.tCell, pdfStyles.bold, { flex: 1 }]}>
                        {breakOverwideWords(
                          block.name,
                          CC_ROW_INNER_PT,
                          CC_BODY_FONT_PT,
                          'Helvetica-Bold',
                        )}
                        {' · '}
                        {block.lines.length}{' '}
                        {block.lines.length === 1 ? 'variant' : 'variants'}
                      </Text>
                    </View>
                  ) : null}

                  {block.lines.map((l, i) => {
                    rowNumber += 1;
                    const counted = l.countedQuantity ?? null;
                    const variance = counted == null ? null : counted - l.expectedQuantity;
                    // The variant is WHAT THE COUNTER IS HOLDING. Printing the
                    // bare name for six sizes of one shoe is how the 10s end
                    // up in the 10.5 column.
                    const description = l.variantLabel
                      ? `${l.name} · ${l.variantLabel}`
                      : l.name;
                    const sku = l.sku || '—';
                    const location = l.location ?? '—';
                    return (
                      <View
                        key={`${block.key}-${l.sku}-${i}`}
                        style={[pdfStyles.tRow, { minHeight: 22 }]}
                        // Kept whole across a page break (see
                        // CC_KEEP_ROW_TOGETHER_MAX_CHARS); a long description
                        // still wraps inside the row, never truncates.
                        wrap={
                          description.length + sku.length + location.length >
                          CC_KEEP_ROW_TOGETHER_MAX_CHARS
                        }
                      >
                        {/* Every cell takes ccCell(): its gutter keeps the
                            text short of the next column without moving any
                            column. A word too wide for its column is broken
                            onto lines that fit instead of running over the
                            next column; a SKU breaks after its own separators,
                            with no hyphen it does not have. */}
                        <Text style={[pdfStyles.tCell, pdfStyles.muted, ccCell(CC_COLS.num)]}>
                          {rowNumber}
                        </Text>
                        <Text style={[pdfStyles.tCell, pdfStyles.tCellMono, ccCell(CC_COLS.sku)]}>
                          {breakIdentifierLines(
                            sku,
                            ccTextWidthPt(CC_COLS.sku),
                            CC_SKU_FONT_PT,
                            'Courier',
                          )}
                        </Text>
                        <Text style={[pdfStyles.tCell, ccCell(CC_COLS.name)]}>
                          {breakOverwideWords(
                            description,
                            ccTextWidthPt(CC_COLS.name),
                            CC_BODY_FONT_PT,
                          )}
                        </Text>
                        <Text style={[pdfStyles.tCell, ccCell(CC_COLS.loc)]}>
                          {breakOverwideWords(
                            location,
                            ccTextWidthPt(CC_COLS.loc),
                            CC_BODY_FONT_PT,
                          )}
                        </Text>
                        <Text style={[pdfStyles.tCell, ccCell(CC_COLS.sysQty, 'center')]}>
                          {l.expectedQuantity}
                        </Text>
                        {isVarianceReport ? (
                          <Text style={[pdfStyles.tCell, ccCell(CC_COLS.countQty, 'center')]}>
                            {counted == null ? '—' : counted}
                          </Text>
                        ) : (
                          <View
                            style={{
                              ...ccCell(CC_COLS.countQty),
                              borderBottomWidth: 0.5,
                              borderBottomColor: PDF_COLORS.lineStrong,
                              borderBottomStyle: 'solid',
                              marginHorizontal: 2,
                            }}
                          />
                        )}
                        {isVarianceReport ? (
                          <Text style={[pdfStyles.tCell, ccCell(CC_COLS.notes, 'center')]}>
                            {variance == null
                              ? '—'
                              : variance === 0
                                ? '0'
                                : `${variance > 0 ? '+' : ''}${variance}`}
                          </Text>
                        ) : (
                          <View
                            style={{
                              ...ccCell(CC_COLS.notes),
                              borderBottomWidth: 0.5,
                              borderBottomColor: PDF_COLORS.lineStrong,
                              borderBottomStyle: 'solid',
                              marginHorizontal: 2,
                            }}
                          />
                        )}
                      </View>
                    );
                  })}

                  {/* Per-group subtotal. DERIVED from the lines above it —
                      product groups own no quantity, so this number exists
                      only on this sheet. The unit is printed because a
                      subtotal of 41 means nothing until it says "pairs". */}
                  {showGroupBlocks && block.name ? (
                    <View style={[pdfStyles.tRow, { minHeight: 20 }]} wrap={false}>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.muted,
                          { flex: CC_COLS.num + CC_COLS.sku + CC_COLS.name + CC_COLS.loc },
                        ]}
                      >
                        Subtotal{block.unit ? ` · ${block.unit}` : ''}
                      </Text>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.bold,
                          { flex: CC_COLS.sysQty, textAlign: 'center' },
                        ]}
                      >
                        {block.expectedSubtotal}
                      </Text>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.bold,
                          { flex: CC_COLS.countQty, textAlign: 'center' },
                        ]}
                      >
                        {block.countedSubtotal == null ? '' : block.countedSubtotal}
                      </Text>
                      <Text style={[pdfStyles.tCell, { flex: CC_COLS.notes }]}> </Text>
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </View>
        </View>

        {/* Sign-off block only on the printable count sheet — closed
            counts have already been signed off in-app. */}
        {!isVarianceReport && (
          <View
            style={{
              marginTop: 24,
              flexDirection: 'row',
              gap: 24,
            }}
            wrap={false}
          >
            <Signature label="Counted by" />
            <Signature label="Date" />
            <Signature label="Approved by" />
          </View>
        )}

        <View style={pdfStyles.footer} fixed>
          <Text>
            {org.name} ·{' '}
            {isVarianceReport
              ? 'Cycle count variance report'
              : 'Cycle count sheet · Print and count by hand'}
          </Text>
          <Text
            style={pdfStyles.pageNumber}
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

function Signature({ label }: { label: string }) {
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          height: 28,
          borderBottomWidth: 1,
          borderBottomColor: PDF_COLORS.ink2,
          borderBottomStyle: 'solid',
        }}
      />
      <Text style={[pdfStyles.small, pdfStyles.muted, { marginTop: 4 }]}>
        {label}
      </Text>
    </View>
  );
}
