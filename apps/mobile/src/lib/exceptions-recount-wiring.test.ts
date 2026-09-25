import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * F1-2 on the phone: WIRING PINS for the recount sheet, the Exceptions list
 * and detail, the item screen's "Count this item", and the count screen's
 * Post fix and linked exceptions.
 *
 * The screens cannot render under this node test environment (vitest compiles
 * src/** only; app/ imports native modules at load), so the load-bearing
 * wiring is pinned at source level. The rules themselves are pure and tested
 * in exceptions-api.test.ts, count-close-gate.test.ts and core. Each pin is a
 * rule the owner set or the plan requires:
 *   1. only a manager who can start counts is offered a recount, and only on
 *      rows the server says a recount can settle;
 *   2. the recount is ONLINE ONLY: offline it is disabled with the reason,
 *      from the live network state;
 *   3. one count per selection: the idempotency key belongs to the selection
 *      and is dropped on a conflict;
 *   4. Post is shown only on a known yes from core cycleCountCloseGate (the
 *      role, not stock:adjust alone);
 *   5. a linked line's destination is the server's, shown only while it is
 *      current; a failed read says unavailable.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Source with comments stripped, so a header explaining what a screen avoids
 *  cannot trip the negative pins. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sheet = codeOnly(read('../components/exception-recount-sheet.tsx'));
const list = codeOnly(read('../../app/(drawer)/exceptions.tsx'));
const detail = codeOnly(read('../../app/exceptions/[id].tsx'));
const item = codeOnly(read('../../app/item/[id].tsx'));
const count = codeOnly(read('../../app/cycle-count/[id].tsx'));

describe('recount sheet', () => {
  it('starts through the Bearer route with the selection, the assignee and the key', () => {
    expect(sheet).toContain('startRecount({ occurrenceIds, itemIds, assignedTo: assignee, idempotencyKey })');
    expect(sheet).not.toContain('.rpc(');
  });

  // Mutation caught: a new key per press (a retry after a lost answer would
  // start a second count), or a conflicting key sent again.
  it('the key belongs to the selection and is dropped on a conflict', () => {
    expect(sheet).toContain('keyRef.current = recountKeyFor(keyRef.current, occurrenceIds, itemIds);');
    expect(sheet).toContain('if (described.dropKey) keyRef.current = null;');
    expect(sheet).not.toContain('newClientEventId()');
  });

  // Mutation caught: `online: true`.
  it('is online only: disabled with the reason from the live network state', () => {
    expect(sheet).toContain('recountDisabledReason({ canRecount: true, online })');
    expect(sheet).toContain('disabled={!canSubmit}');
    expect(sheet).toContain('{disabledReason}');
    expect(sheet).not.toMatch(/online:\s*true/);
  });

  it('assigns from the reassign sheet member source (accepted members)', () => {
    expect(sheet).toContain('loadOrgMembers<');
    expect(sheet).toContain('acceptedOnly: true');
    expect(sheet).toContain('buildReassignCandidates(rows, profiles)');
    expect(sheet).toContain('Team members could not be loaded.');
  });

  it('Count this item names the item and only its recountable open exceptions', () => {
    expect(sheet).toContain("listExceptions('open', { itemId })");
    expect(sheet).toContain('list.occurrences.filter((o) => o.canRecount).map((o) => o.id)');
    // Why it is withheld, as the server says (the module, or the role).
    expect(sheet).toContain('recountUnavailableCopy(targets.unavailableReason)');
    expect(sheet).toContain('unavailableReason: list.recountUnavailableReason');
  });

  it('words the result through core, like the web dialog', () => {
    expect(sheet).toContain('recountResultSummary(result, { timeZone, assigneeLabel })');
    expect(sheet).toContain('RECOUNT_COUNTS_TOTAL_COPY');
    expect(sheet).toContain('accessibilityRole="alert"');
  });
});

describe('exceptions list: Recount selected', () => {
  // Mutation caught: Select offered to every reader, or every row pickable.
  it('only for a reader who may recount, and only rows the server says can be recounted', () => {
    expect(list).toContain("!!list && list.status === 'open' && list.canRecount && list.occurrences.some((o) => o.canRecount)");
    expect(list).toContain('selecting={selecting && canSelect && item.occurrence.canRecount}');
  });

  it('refuses an empty or oversized selection, and offline, with the reason', () => {
    expect(list).toContain('recountSelectionProblem(pickedCount) ?? (offline ? RECOUNT_OFFLINE_COPY : null)');
    expect(list).toContain('disabled={recountReason !== null}');
    expect(list).toContain('recountSelectedLabel(pickedCount)');
    expect(list).toContain('online={!offline}');
  });

  it('the selection belongs to the workspace and tab it was made on', () => {
    expect(list).toContain("const picked: ReadonlySet<string> = selection.key === viewKey ? selection.ids : new Set();");
  });
});

describe('exception detail: Recount', () => {
  it('Recount only when the server says so; otherwise who can', () => {
    expect(detail).toContain('{o.canRecount ? (');
    expect(detail).toContain('recountUnavailableCopy(o.recountUnavailableReason)');
    expect(detail).toContain('const showRecount = isRecountableRule(o.rule) && !resolved;');
  });

  it('offline it is disabled with the reason', () => {
    expect(detail).toContain('recountDisabledReason({ canRecount: true, online: !offline })');
    expect(detail).toContain('disabled={recountReason !== null}');
  });

  it('shows the linked recount and a closed recount\'s outcome in the timeline', () => {
    expect(detail).toContain('activeRecountCopy(o.recount)');
    expect(detail).toContain('recountOutcome: e.cycleCount?.outcome ?? null');
    expect(detail).toContain('describeTimelineEvent({');
  });
});

describe('item screen: Count this item', () => {
  // Mutation caught: stock:adjust alone (staff).
  it('for a manager who can start counts, on a countable item', () => {
    expect(item).toMatch(
      /const canStartCounts = countStartAllowed\(\{\s+role: role as Role \| null,\s+permissions,\s+cycleCountsEnabled: enabledModules\.has\('cycle_counts'\),\s+\}\);/,
    );
    expect(item).toContain('{canStartCounts &&');
    expect(item).toContain('isCountableItem({ status: item.status, is_rental: item.is_rental, is_bundle: item.is_bundle })');
    expect(item).toMatch(/bin_location, is_rental, is_bundle,/);
  });

  it('opens the recount sheet for the item, online state live', () => {
    expect(item).toContain('itemId={item.id}');
    expect(item).toContain('isOfflineState(useNetworkState())');
    expect(item).toContain('online={!offline}');
  });
});

describe('count screen: the Post fix and linked exceptions', () => {
  // Mutation caught: gating Post on stock:adjust (canWrite / canAdjust) alone.
  it('Post appears only on a known yes from the close gate', () => {
    expect(count).toContain('fetchCountCloseGate(userId, orgId)');
    expect(count).toContain('const footer = countFooter({');
    expect(count).toContain("{footer.kind === 'post' ? (");
    expect(count).toContain("if (closeGateView.kind !== 'known' || !closeGateView.gate.canPost) return;");
    expect(count).not.toContain('postDisabled');
  });

  it('a known no, or no answer, says so instead of offering Post', () => {
    expect(count).toContain('{footer.text}');
    expect(count).toContain("footer.kind === 'unknown' && footer.retry");
  });

  it('reads the linked exceptions after the count is on screen; a failure says unavailable', () => {
    expect(count).toContain('getCountLinkedExceptions(id)');
    expect(count).toContain("links.organizationId === orgId ? { kind: 'ready', data: links } : { kind: 'failed' }");
    expect(count).toContain('COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY');
  });

  it('shows the destination only while it describes the line on the phone', () => {
    expect(count).toContain('linkedLineDestination(\n                    links[0]!,');
    // The count's status decides: a closed count reads its outcome.
    expect(count).toContain('linked.data.status,');
    expect(count).toContain('countedLocationId: serverLocations.get(l.id)');
    expect(count).toContain('localDirty: l.localDirty');
    expect(count).toContain('drafting: isDrafting');
  });

  it('caps the chip label as chrome (Dynamic Type), never the destination line', () => {
    expect(count).toContain('maxFontSizeMultiplier={LINK_CHIP_CAP}');
    expect(count).toContain('const LINK_CHIP_CAP = capTo(12, TYPE_CEILING.chrome);');
    expect(count).toMatch(/linkChip: \{\s+minHeight: 24,/);
  });
});
