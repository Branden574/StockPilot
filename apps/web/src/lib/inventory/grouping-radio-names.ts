import { groupingRecordLine, type GroupingRecordLineFacts } from '@stockpilot/core';

/**
 * RADIO NAMES THAT TELL RECORDS APART (redesign Stage 6).
 *
 * The grouping reviews name a record's radio for its record: the Ungroup
 * review's "Keeps SKU X: <name>". Records that share a name (three Wireless
 * Mouse records on three racks, all of one SKU) were radios with one name, so
 * a screen reader could not tell them apart.
 *
 * A radio's name now goes on, after the record's name, with the parts of the
 * record's own line (core groupingRecordLine: its SKU, ISBN, size, charter,
 * rack or placement, warehouse and on hand) that are not on every line of the
 * records it is told apart from, in the line's own words. Records whose names
 * and lines still read the same end with "record N of M", where they are
 * listed. The phone names its Ungroup radios with the same rule and words
 * (apps/mobile keepsSkuRadioLabel), so the web and the phone say the same.
 * The visible words and the outcome (the radio's description) do not change.
 */

/** A record as its radio names it: its id, its name and its line's facts. */
export type RadioRecord = GroupingRecordLineFacts & { id: string; name: string };

/** How a record's line joins its parts (core groupingRecordLine). */
const RECORD_LINE_SEPARATOR = ' · ';

/**
 * The name of one record's radio: `lead` gives the words it starts with for
 * the record's name (core's choice and the name), then come the parts of the
 * record's line that are not on every one of the peers' lines, and "record N
 * of M" when another peer would still read the same. `peers` are the records
 * the radio is told apart from, the record included, in the order listed.
 */
export function recordRadioName(
  lead: (name: string) => string,
  record: RadioRecord,
  peers: readonly RadioRecord[],
  view: 'items' | 'books',
): string {
  const parts = (r: RadioRecord) => groupingRecordLine(r, view).split(RECORD_LINE_SEPARATOR);
  const lines = peers.map(parts);
  const onEvery = new Set((lines[0] ?? []).filter((p) => lines.every((l) => l.includes(p))));
  const named = (r: RadioRecord) =>
    [lead(r.name), ...parts(r).filter((p) => !onEvery.has(p))].join(', ');
  const label = named(record);
  const at = peers.findIndex((p) => p.id === record.id);
  const readsTheSame = peers.some((p) => p.id !== record.id && named(p) === label);
  return at >= 0 && readsTheSame ? `${label}, record ${at + 1} of ${peers.length}` : label;
}

/**
 * The Ungroup review's "keeps the SKU" radio (Stage 6, UNGROUP-WEB-RADIO-NAMES):
 * core's choice ("Keeps SKU X") and the record's name, told apart from the
 * SKU's other records with a radio. The phone's keepsSkuRadioLabel, with the
 * same arguments and the same words: `rows` are the review's records in the
 * order listed, `skuRecords` the SKU's records that each carry a radio (core's
 * group.selected).
 */
export function keepsSkuRadioLabel(
  choice: string,
  record: RadioRecord,
  rows: readonly RadioRecord[],
  skuRecords: readonly { id: string }[],
  view: 'items' | 'books',
): string {
  const withRadio = new Set(skuRecords.map((s) => s.id));
  return recordRadioName(
    (name) => `${choice}: ${name}`,
    record,
    rows.filter((r) => withRadio.has(r.id)),
    view,
  );
}
