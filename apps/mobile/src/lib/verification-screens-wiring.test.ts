import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * F1-3 on the phone: WIRING PINS for the "last physical count" card (item
 * screen and exception detail), the location screen and the Locations list.
 *
 * The screens cannot render under this node test environment (vitest compiles
 * src/** only; app/ imports native modules at load), so the load-bearing
 * wiring is pinned at source level. The logic is pure and tested in
 * verification-api.test.ts, locations-list.test.ts and core's
 * verification.test.ts. Each pin is a rule the owner set or the plan requires:
 *   1. the facts come from the shared service through the Bearer routes, and
 *      the words from core, so the phone and the browser agree;
 *   2. a failed read says "Couldn't load verification" (with Try again where
 *      it can help), never "No physical count on record." or an empty
 *      location;
 *   3. the card is off the item screen's critical path: its own read, started
 *      with the item's, never awaited by it;
 *   4. only the newest read lands, and only for the workspace on screen;
 *   5. "Recount items here" is for a reader the server says may start one,
 *      disabled with the reason, and gathers every page;
 *   6. every touchable is announced with a role and words (VoiceOver).
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Source with comments stripped, so a header explaining what a screen avoids
 *  cannot trip the negative pins. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const card = codeOnly(read('../components/item-verification-card.tsx'));
const item = codeOnly(read('../../app/item/[id].tsx'));
const detail = codeOnly(read('../../app/exceptions/[id].tsx'));
const location = codeOnly(read('../../app/location/[id].tsx'));
const list = codeOnly(read('../screens/locations.tsx'));
const sheet = codeOnly(read('../components/exception-recount-sheet.tsx'));
const rootLayout = read('../../app/_layout.tsx');

describe('the card (components/item-verification-card.tsx)', () => {
  it('reads the shared service through the Bearer route, never Supabase', () => {
    expect(card).toContain('getItemVerification(itemId, { orgId })');
    expect(card).not.toContain('supabase');
    expect(card).not.toContain('.rpc(');
  });

  it("words the summary through core, with the org zone and the server's canCount", () => {
    expect(card).toMatch(
      /verificationSummaryCopy\(data\.summary, \{\s+timeZone: data\.timeZone,\s+canCount: data\.canCount,?\s+\}\)/,
    );
    expect(card).toContain('verificationIssueChipCopy(issue)');
    // No words of its own for the count: never a hand-written "never counted".
    expect(card).not.toMatch(/No physical count|never counted|verified|%/i);
  });

  // Mutation caught: a catch that stores an empty summary (lastCount null),
  // which reads "No physical count on record.".
  it('a failed read is stored as the failure and shown as "Couldn\'t load verification" with Try again', () => {
    expect(card).toContain(
      "setStored((prev) => verificationFailure(prev, key, e, 'item', (d) => d.timeZone));",
    );
    expect(card).not.toMatch(/lastCount:\s*null/);
    expect(card).toContain('{VERIFICATION_UNAVAILABLE_COPY}');
    expect(card).toContain('accessibilityRole="alert"');
    expect(card).toContain('{view.error.retry ? (');
    expect(card).toContain("{retrying ? 'Trying again...' : 'Try again'}");
  });

  // Mutation caught: dropping either guard (an older answer, or an older
  // failure, painted over a newer one).
  it('only the newest read lands, and offline nothing is asked (the view is derived)', () => {
    expect(card).toContain('const seq = ++seqRef.current;');
    expect(card).toMatch(
      /if \(seq !== seqRef\.current\) return;\s+setStored\(\{ key, kind: 'ready'/,
    );
    expect(card).toMatch(
      /if \(seq !== seqRef\.current\) return;\s+setStored\(\(prev\) => verificationFailure/,
    );
    expect(card).toContain('isOfflineState(useNetworkState())');
    expect(card).toContain('if (!itemId || !orgId || key === null || offline) return;');
    expect(card).toContain('verificationView(stored, key, offline, (d) => d.timeZone)');
    expect(card).toMatch(/\}, \[load, refreshKey\]\);/);
  });

  it("links a count only for a reader who can open counts (the web's rule); otherwise names it", () => {
    expect(card).toContain('onOpenCount={canOpenCounts ? onOpenCount : null}');
    expect(card).toContain('{countId && onOpenCount ? (');
    expect(card).toContain('{beingCounted && onOpenCount ? (');
    expect(item).toContain('const canOpenCounts = canOpenCountScreen(role, permissions);');
    expect(item).toContain('canOpenCounts={canOpenCounts}');
    expect(detail).toContain(
      'const canOpenCounts = canOpenCountScreen(role, useEffectivePermissions());',
    );
    expect(detail).toContain('canOpenCounts={canOpenCounts}');
  });

  it('offers "Count this item" only with a handler and core\'s yes', () => {
    expect(card).toContain('{copy.countAction && onCount ? (');
  });

  // L4 (review 2026-09-27): the issue chips were 36pt and the link lines
  // bare text (about 38pt with hitSlop), below the 44pt iOS minimum.
  it('every touchable on the card is at least 44pt tall, and no link line borrows hitSlop', () => {
    const file = 'src/components/item-verification-card.tsx';
    const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
    const minTap = /const MIN_TAP = (\d+);/.exec(card);
    expect(minTap, 'MIN_TAP').not.toBeNull();
    expect(Number(minTap![1])).toBeGreaterThanOrEqual(44);
    const pressables = elementsOf(file, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(pressables.length).toBeGreaterThanOrEqual(2);
    for (const p of pressables) {
      const style = attrText(p.el, 'style', sf) ?? '';
      const m = /minHeight:\s*(MIN_TAP|\d+)/.exec(style);
      expect(m, `${where(p)} has no minHeight`).not.toBeNull();
      const h = m![1] === 'MIN_TAP' ? Number(minTap![1]) : Number(m![1]);
      expect(h, `${where(p)} minHeight`).toBeGreaterThanOrEqual(44);
      expect(attrText(p.el, 'hitSlop', sf), `${where(p)} hitSlop`).toBeUndefined();
    }
  });

  it('links the count, the open count, the movements and each exception', () => {
    expect(card).toContain('onOpenCount(countId)');
    expect(card).toContain('onOpenCount(beingCounted.cycleCountId)');
    expect(card).toContain('onOpenIssue(issue.id)');
    expect(card).toContain('data.summary.movementsSince !== null ? onOpenMovements : null');
    expect(card).toContain('verificationCheckedAtCopy(data.checkedAt, data.timeZone)');
  });
});

describe('item screen: the card', () => {
  // Mutation caught: calling the hook with `item.organization_id` only, which
  // waited for the whole item read (and its photo) before asking.
  it("starts its read with the item read, under the active workspace until the item's own is known", () => {
    expect(item).toContain(
      'useItemVerification(id, item?.organization_id ?? orgId, verificationNonce)',
    );
    // A hook: above the screen's early return for a missing item.
    expect(item.indexOf('useItemVerification(')).toBeLessThan(
      item.indexOf('if (!item) {\n    return ('),
    );
  });

  it('is not awaited by the item read (off the critical path)', () => {
    expect(item).not.toMatch(/await[^;\n]*verification/i);
  });

  it('reads again after a pull, an adjustment, a move, a removal and a started count', () => {
    expect(item).toContain(
      'const refreshVerification = React.useCallback(() => setVerificationNonce((n) => n + 1), []);',
    );
    expect(item.match(/refreshVerification\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('opens the Movements tab, a count and an exception; Count this item stays in the stock card', () => {
    expect(item).toContain('<ItemVerificationCard');
    expect(item).toContain("onOpenMovements={() => setTab('movements')}");
    const cardJsx = item.slice(
      item.indexOf('<ItemVerificationCard'),
      item.indexOf('/>', item.indexOf('<ItemVerificationCard')),
    );
    expect(cardJsx).not.toContain('onCount');
  });
});

describe('exception detail: the card and the location link', () => {
  it('reads the item of this exception for the workspace it belongs to', () => {
    expect(detail).toMatch(
      /useItemVerification\(\s+o\.item \? o\.itemId : null,\s+detail\.organizationId,\s+verificationRefreshKey,\s+\)/,
    );
    expect(detail).toContain('{o.item ? (\n        <ItemVerificationCard');
    expect(detail).toContain('excludeIssueId={o.id}');
  });

  // M3 (review 2026-09-27): the card offered "Count this item" on every
  // exception whose rule a Recount cannot settle (stale_staging,
  // long_unplaced, orphaned_stock, label_mismatch), which the web and the
  // plan withhold: recounting a Staging or archived-location holding can
  // correct the wrong place. It stays on the item screen.
  it('offers no "Count this item" on the exception detail (the web\'s rule)', () => {
    const cardJsx = detail.slice(
      detail.indexOf('<ItemVerificationCard'),
      detail.indexOf('/>', detail.indexOf('<ItemVerificationCard')),
    );
    expect(cardJsx).toContain('excludeIssueId={o.id}');
    expect(cardJsx).not.toContain('onCount');
    expect(detail).not.toContain('COUNT_THIS_ITEM_LABEL');
    expect(detail).not.toMatch(/\bcountOpen\b|\bsetCountOpen\b/);
  });

  it('re-reads the card with the exception (a pull, and a finished recount)', () => {
    expect(detail).toMatch(/setRefreshing\(true\);\s+setVerificationNonce\(\(n\) => n \+ 1\);/);
    expect(detail).toMatch(/setRecountOpen\(false\);[^}]*setVerificationNonce\(\(n\) => n \+ 1\);/);
  });

  it('the location opens the location screen', () => {
    expect(detail).toContain('onPress={() => onNavigate(`/location/${o.locationId}`)}');
  });
});

describe('location screen (app/location/[id].tsx)', () => {
  it('reads the shared service a page at a time for the workspace on screen, never Supabase', () => {
    expect(location).toContain('getLocationVerification(id, { orgId, page })');
    expect(location).not.toContain('supabase');
    expect(location).not.toContain('.rpc(');
    expect(location).toContain('const key = verificationKey(id, orgId, page);');
  });

  it('only the newest read lands; a failure is stored as the failure', () => {
    expect(location).toContain('const seq = ++seqRef.current;');
    expect(location).toMatch(
      /if \(seq !== seqRef\.current\) return;\s+setStored\(\{ key, kind: 'ready'/,
    );
    expect(location).toMatch(
      /if \(seq !== seqRef\.current\) return;\s+setStored\(\(prev\) => verificationFailure/,
    );
    expect(location).toContain(
      "setStored((prev) => verificationFailure(prev, key, e, 'location', (d) => d.timeZone));",
    );
    expect(location).toContain('verificationView(stored, key, offline, (d) => d.timeZone)');
  });

  // Mutation caught: an error rendered as an empty location.
  it('a failed read says "Couldn\'t load verification" with Try again, never an empty location', () => {
    expect(location).toContain('{VERIFICATION_UNAVAILABLE_COPY}');
    expect(location).toContain('{view.error.detail}');
    expect(location).toContain('{view.error.retry ? (');
    expect(location).not.toMatch(/catch \([^)]*\) \{[^}]*rows: \[\]/);
  });

  it('out of the reader\'s warehouses: says so, never "nothing here"', () => {
    expect(location).toContain('{!data.holdingsVisible || !data.totals ? (');
    expect(location).toContain('{LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY}');
  });

  // L2 (review 2026-09-27): the page's kind AND type, so a Site's page is
  // not called a shelf (core isRackShelfLocation needs both).
  it("words the rows and the totals through core, with the page's kind and type", () => {
    expect(location).toMatch(
      /locationRowVerificationCopy\(row\.summary, locationId, \{\s+timeZone,\s+locationKind,\s+locationType,\s+\}\)/,
    );
    expect(location).toMatch(
      /locationVerificationTotalsCopy\(data\.totals, \{\s+locationKind: loc\.kind,\s+locationType: loc\.type,\s+\}\)/,
    );
    expect(location).toContain('locationType={loc.type}');
    expect(location).toContain('verificationIssueChipCopy(issue)');
    expect(location).toContain('<Paginator');
    expect(location).toContain('{LOCATION_HOLDINGS_TRUNCATED_COPY}');
  });

  // M2 (review 2026-09-27): the open exceptions are read under the reader's
  // RLS, so none come back out of their warehouses: that is not "none
  // recorded". Core picks the words (the web page's too).
  it("open issues here: the chips, or core's words for none (out of scope, first check pending, none you can see)", () => {
    expect(location).toMatch(
      /locationOpenIssuesEmptyCopy\(\{\s+holdingsVisible: data\.holdingsVisible,\s+hiddenItems: data\.totals\?\.hiddenItems \?\? 0,\s+checkedAt: data\.checkedAt,\s+\}\)/,
    );
    expect(location).toContain('{noIssues.text}');
    expect(location).not.toContain('LOCATION_NO_OPEN_ISSUES_COPY');
    expect(location).toContain('verificationCheckedAtCopy(data.checkedAt, data.timeZone)');
  });

  it('with no workspace, says so and loads it again on Try again', () => {
    expect(location).toContain('if (!orgId && !workspaceLoading) {');
    expect(location).toContain('{LOCATION_WORKSPACE_UNAVAILABLE}');
    expect(location).toContain('await retryWorkspace();');
  });

  // Mutation caught: `online: true`, a button for every reader, or gathering
  // only the page on screen.
  it("Recount items here: the server's yes, disabled with the reason, every page gathered, online state live", () => {
    expect(location).toContain('const recount = locationRecountState(data, !offline);');
    expect(location).toContain('{recount.show ? (');
    expect(location).toContain(
      "disabled={recount.disabledReason !== null || gather.kind === 'gathering'}",
    );
    expect(location).toContain('{recount.disabledReason}');
    expect(location).toContain('gatherRecountItemIds(data, (p) =>');
    expect(location).toContain("itemIds={gather.kind === 'ready' ? gather.itemIds : []}");
    expect(location).toContain('online={!offline}');
    expect(location).toContain('title={LOCATION_RECOUNT_LABEL}');
  });

  it('is a registered stack screen', () => {
    expect(rootLayout).toContain(
      '<Stack.Screen name="location/[id]" options={{ presentation: \'card\' }} />',
    );
  });
});

describe('recount sheet: a list of items ("Recount items here")', () => {
  it('sends the given items, and says how many', () => {
    expect(sheet).toContain('const itemIds = itemId ? [itemId] : [...givenItemIds];');
    expect(sheet).toContain(
      "The recount will include ${itemIds.length === 1 ? '1 item' : `${itemIds.length} items`}.",
    );
  });
});

describe('Locations list (src/screens/locations.tsx)', () => {
  it('each row opens the location screen', () => {
    expect(list).toContain('router.push(`/location/${l.id}` as Href)');
  });

  // Mutation caught: `data ?? []` on a failed read ("No locations yet.").
  it('reads every page through readLocationList and says a failed read', () => {
    expect(list).toContain('readLocationList(supabase, orgId)');
    expect(list).toContain('LOCATIONS_LIST_UNAVAILABLE_COPY');
    expect(list).toContain(
      "emptyTitle={failedEmpty ? LOCATIONS_LIST_UNAVAILABLE_COPY : 'No locations yet.'}",
    );
    expect(list).not.toContain("from('locations')");
  });

  it("only this workspace's rows are shown", () => {
    expect(list).toContain('const list = stored && stored.orgId === orgId ? stored : null;');
  });
});

// ── VoiceOver: every touchable is announced with a role and words ──────────

const FILES = [
  'app/location/[id].tsx',
  'src/components/item-verification-card.tsx',
  'src/screens/locations.tsx',
];

type Found = { el: JsxNode; sf: ts.SourceFile; file: string };

function elementsOf(file: string, pred: (el: JsxNode, sf: ts.SourceFile) => boolean): Found[] {
  const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
  const out: Found[] = [];
  walkJsx(sf, (el) => {
    if (pred(el, sf)) out.push({ el, sf, file });
  });
  return out;
}

function rendersText(el: JsxNode): boolean {
  if (!ts.isJsxElement(el)) return false;
  return el.children.some((ch) => {
    if (ts.isJsxText(ch)) return !ch.containsOnlyTriviaWhiteSpaces;
    if (ts.isJsxExpression(ch)) return ch.expression !== undefined;
    if (ts.isJsxElement(ch)) return rendersText(ch);
    return false;
  });
}

function where(f: Found): string {
  const { line } = f.sf.getLineAndCharacterOfPosition(f.el.getStart(f.sf));
  return `${f.file}:${line + 1} <${tagOf(f.el, f.sf)}>`;
}

describe('F1-3 screens: every touchable is named for VoiceOver', () => {
  it.each(FILES)('%s', (file) => {
    const touchables = elementsOf(file, (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)));
    expect(touchables.length).toBeGreaterThan(0);
    for (const t of touchables) {
      expect(['button', 'link'], `${where(t)} has no role`).toContain(
        attrText(t.el, 'accessibilityRole', t.sf),
      );
      const named = attrText(t.el, 'accessibilityLabel', t.sf) !== undefined || rendersText(t.el);
      expect(named, `${where(t)} has nothing for VoiceOver to read`).toBe(true);
    }
  });

  it('every icon-only chip has a label', () => {
    for (const file of FILES) {
      for (const chip of elementsOf(file, (el, sf) => tagOf(el, sf) === 'IconChip')) {
        expect(
          attrText(chip.el, 'accessibilityLabel', chip.sf),
          `${where(chip)} is unlabelled`,
        ).toBeTruthy();
      }
    }
  });

  // A touchable inside a touchable is folded into the outer one and cannot be
  // reached: the location rows keep their chips as words.
  it('no touchable sits inside another', () => {
    for (const file of FILES) {
      const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
      walkJsx(sf, (el, ancestors) => {
        if (!TOUCHABLE_TAG.test(tagOf(el, sf))) return;
        const outer = ancestors.find((a) => TOUCHABLE_TAG.test(tagOf(a, sf)));
        expect(
          outer,
          `${file}: <${tagOf(el, sf)}> inside <${outer ? tagOf(outer, sf) : ''}>`,
        ).toBeUndefined();
      });
    }
  });
});
