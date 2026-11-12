import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classicFlat, flatNorm } from './__fixtures__/classic-projection';

/**
 * THE OPERATIONS SCREENS' REVIEW FIXES, READ AS SOURCE (Liquid Glass stage 4,
 * native-ops lane, fix round of 2026-11-08).
 *
 * Two reviewers read the lane against the boards. What they found, and what
 * these pin, each in Liquid Glass only (Classic is read off its projection and
 * must keep its exact text):
 *
 *   - the record and form heads drop Classic's uppercase eyebrow over the
 *     title and say its words under it; the title is the iOS-Item name
 *     (26/31, GLASS_ITEM.name) with no emphasis and no full stop; the Reports
 *     section label is an iOS heading;
 *   - Book Order Totals' large title at the boards' 34;
 *   - the segmented controls draw every segment's words in ink;
 *   - a borrower suggestion shows its press;
 *   - words inside the floating action bar sit clear of its clipped corners;
 *   - the Returns split's rule is the boards' --line-2 hairline;
 *   - Bundles' Refresh capsule says its word at 15.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

function source(file: string): string {
  return readFileSync(path.join(MOBILE_ROOT, file), 'utf8');
}

/** Source with comments stripped and whitespace made one space (flatNorm). */
function code(file: string): string {
  return flatNorm(
    source(file)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  );
}

const classic = (file: string) => classicFlat(source(file), file);

describe('record and form heads: no eyebrow over the title in Liquid Glass', () => {
  const HEADS: {
    file: string;
    classicWords: string[];
    glass: string[];
  }[] = [
    {
      file: 'app/rentals/new.tsx',
      classicWords: ['<Eyebrow>RENTALS · NEW CHECKOUT</Eyebrow>', 'Check <Em>out.</Em>'],
      glass: [
        '{lg ? null : <Eyebrow>RENTALS · NEW CHECKOUT</Eyebrow>}',
        "{lg ? glassListTitle('Check', 'out.') : 'Check '} {lg ? null : <Em>out.</Em>}",
        '{lg ? <GlassSubline style={GLASS_LIST.sub}>Rentals · New checkout</GlassSubline> : null}',
      ],
    },
    {
      file: 'app/schedule/new.tsx',
      classicWords: ['<Eyebrow>SCHEDULE · NEW EVENT</Eyebrow>', 'Add to <Em>calendar.</Em>'],
      glass: [
        '{lg ? null : <Eyebrow>SCHEDULE · NEW EVENT</Eyebrow>}',
        "{lg ? glassListTitle('Add to', 'calendar.') : 'Add to '} {lg ? null : <Em>calendar.</Em>}",
        '{lg ? <GlassSubline style={GLASS_LIST.sub}>Schedule · New event</GlassSubline> : null}',
      ],
    },
    {
      file: 'app/po-import/[id].tsx',
      classicWords: ['<Eyebrow>PROCUREMENT · PO IMPORT</Eyebrow>', 'Review <Em>import.</Em>'],
      glass: [
        '{lg ? null : <Eyebrow>PROCUREMENT · PO IMPORT</Eyebrow>}',
        "{lg ? glassListTitle('Review', 'import.') : 'Review '} {lg ? null : <Em>import.</Em>}",
        '{lg ? <GlassSubline style={GLASS_LIST.sub}>Procurement · PO import</GlassSubline> : null}',
      ],
    },
    {
      file: 'app/group-selected.tsx',
      classicWords: ["<Eyebrow>{view === 'books' ? 'BOOKS · GROUP' : 'ITEMS · GROUP'}</Eyebrow>"],
      glass: [
        "{lg ? null : <Eyebrow>{view === 'books' ? 'BOOKS · GROUP' : 'ITEMS · GROUP'}</Eyebrow>}",
        "<GlassSubline style={GLASS_LIST.sub}> {view === 'books' ? 'Books · Group' : 'Items · Group'} </GlassSubline>",
      ],
    },
    {
      file: 'app/ungroup-selected.tsx',
      classicWords: [
        "<Eyebrow>{view === 'books' ? 'BOOKS · UNGROUP' : 'ITEMS · UNGROUP'}</Eyebrow>",
      ],
      glass: [
        "{lg ? null : <Eyebrow>{view === 'books' ? 'BOOKS · UNGROUP' : 'ITEMS · UNGROUP'}</Eyebrow>}",
        "<GlassSubline style={GLASS_LIST.sub}> {view === 'books' ? 'Books · Ungroup' : 'Items · Ungroup'} </GlassSubline>",
      ],
    },
    {
      file: 'app/maintenance/new.tsx',
      classicWords: [
        "{createdId ? 'ADD PHOTOS' : escalationId ? 'ESCALATE TO MAINTENANCE' : 'NEW MAINTENANCE REQUEST'}",
        'Report an <Em>issue.</Em>',
      ],
      glass: [
        "{lg ? ( createdId ? ( glassListTitle('Add', 'photos.') ) : escalationId ? ( glassListTitle('Escalate an', 'exception.') ) : ( glassListTitle('Report an', 'issue.') ) ) : createdId ? (",
        "{lg ? ( createdId ? null : ( <GlassSubline style={GLASS_LIST.sub}> {escalationId ? 'Escalate to maintenance' : 'New maintenance request'} </GlassSubline> ) ) : null}",
      ],
    },
    {
      file: 'app/maintenance/[id].tsx',
      classicWords: ['<Eyebrow>{handle}</Eyebrow>'],
      glass: [
        "{lg ? null : ( <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}> <Wrench size={16} color={c.ink3} strokeWidth={1.5} /> <Eyebrow>{handle}</Eyebrow> </View> )}",
        '{lg ? ( <Mono size={12.5} tracking={0.04} color={c.ink3} style={GLASS_RECORD_META}> {handle} </Mono> ) : null}',
      ],
    },
    {
      file: 'app/location/[id].tsx',
      classicWords: [
        '<View style={{ gap: 8 }}> <Eyebrow> {[locationKindLabel(loc.kind, loc.type), loc.warehouseName]',
      ],
      glass: [
        '<View style={lg ? GLASS_RECORD_TITLE_BLOCK : { gap: 8 }}>',
        '{lg ? null : ( <Eyebrow> {[locationKindLabel(loc.kind, loc.type), loc.warehouseName]',
        "{lg ? ( <Mono size={12.5} tracking={0.04} color={c.ink3}> {[locationKindLabel(loc.kind, loc.type), loc.warehouseName].filter(Boolean).join(' · ')} </Mono> ) : null}",
      ],
    },
  ];

  for (const { file, classicWords, glass } of HEADS) {
    // Mutation caught: an eyebrow or Em left in reach of the glass branch, a
    // subline missing, or Classic's head changed.
    it(`${file}: Classic keeps its head; Liquid Glass says the eyebrow under the title`, () => {
      const flat = code(file);
      for (const words of classicWords) expect(classic(file), words).toContain(flatNorm(words));
      for (const words of glass) expect(flat, words).toContain(flatNorm(words));
      // The title is the iOS-Item name (26/31) in glass.
      expect(flat).toContain(flatNorm('style={lg ? GLASS_ITEM.name :'));
    });
  }

  // Mutation caught: the eyebrow back over the book's name in glass.
  it("Book Order Totals' orders: the eyebrow's words are the nav's title in Liquid Glass", () => {
    const file = 'app/reports/book-order-totals/[itemId].tsx';
    expect(classic(file)).toContain(flatNorm('<Eyebrow>BOOK ORDER TOTALS · ORDERS</Eyebrow>'));
    const flat = code(file);
    expect(flat).toContain(flatNorm('{lg ? null : <Eyebrow>BOOK ORDER TOTALS · ORDERS</Eyebrow>}'));
    expect(flat).toContain(
      flatNorm(
        '{lg ? <GlassPoNavTitle lg={lg} title="Book Order Totals · Orders" /> : null} {lg ? <GlassNavSpacer /> : null}',
      ),
    );
  });

  // Mutation caught: the Reports section back to an uppercase eyebrow in glass.
  it('the Reports section label is an iOS heading in Liquid Glass', () => {
    const file = 'src/screens/reports.tsx';
    expect(classic(file)).toContain(flatNorm('<Eyebrow>REPORTS</Eyebrow>'));
    expect(code(file)).toContain(
      flatNorm('{lg ? <GlassHeading>Reports</GlassHeading> : <Eyebrow>REPORTS</Eyebrow>}'),
    );
  });
});

describe('the other review fixes', () => {
  // Mutation caught: the large title back at Classic's 30 in glass.
  it("Book Order Totals' large title is the boards' 34 in Liquid Glass, 30 in Classic", () => {
    const file = 'app/reports/book-order-totals/index.tsx';
    expect(code(file)).toContain(
      flatNorm('<Display size={lg ? 34 : 30} style={lg ? GLASS_LIST.title : { marginTop: 10 }}'),
    );
    expect(classic(file)).toContain(flatNorm('<Display size={30} style={{ marginTop: 10 }}'));
  });

  // Mutation caught: an unchosen segment's words back in ink-3 in glass.
  it("every segment's words are ink in Liquid Glass; Classic keeps ink-3 on the unchosen ones", () => {
    for (const file of [
      'app/(drawer)/exceptions.tsx',
      'app/(drawer)/staging.tsx',
      'src/screens/rentals.tsx',
    ]) {
      expect(code(file), file).toContain(flatNorm('color={lg ? c.ink : active ? c.ink : c.ink3}'));
      expect(classic(file), file).toContain(flatNorm('color={active ? c.ink : c.ink3}'));
    }
    const maintenance = 'app/(drawer)/maintenance.tsx';
    expect(code(maintenance)).toContain(flatNorm('lg && [glassSegLabel(lg), { color: c.ink }]'));
    expect(code(maintenance)).not.toContain('{ color: selected ? c.ink : c.ink3 }');
    expect(classic(maintenance)).toContain(flatNorm('{ color: selected ? c.paper : c.ink3 }'));
  });

  // Mutation caught: the glass suggestion with no press cue.
  it('a borrower suggestion shows its press in Liquid Glass', () => {
    const file = 'app/rentals/new.tsx';
    expect(code(file)).toContain(
      flatNorm('lg && [glassIconWell(lg), pressed && { opacity: 0.7 }]'),
    );
    expect(classic(file)).toContain(
      flatNorm('{ borderColor: c.hair2, backgroundColor: pressed ? c.sunk : c.card }'),
    );
  });

  // Mutation caught: words in the floating bar back at its 7pt edge.
  it("words inside the floating action bar take the bar's note inset in Liquid Glass", () => {
    const po = code('app/po-import/[id].tsx');
    const inset = flatNorm(
      'style={lg ? [{ lineHeight: 16 }, GLASS_ACTION_BAR_NOTE] : { lineHeight: 16 }}',
    );
    expect(po.split(inset)).toHaveLength(3);
    expect(code('app/maintenance/new.tsx')).toContain(
      flatNorm('style={lg ? [{ marginBottom: 10 }, GLASS_ACTION_BAR_NOTE] : { marginBottom: 10 }}'),
    );
    expect(classic('app/maintenance/new.tsx')).toContain(
      flatNorm(
        '<Body size={13} muted accessibilityRole="alert" style={{ marginBottom: 10 }}> {escalation.state.reason} </Body>',
      ),
    );
  });

  // Mutation caught: Classic's 1px c.hair rule kept in glass.
  it("the Returns split's rule is the --line-2 hairline in Liquid Glass", () => {
    const file = 'app/(drawer)/returns.tsx';
    expect(code(file)).toContain(
      flatNorm(
        'style={[ styles.splitDetail, { borderColor: c.hair }, lg && glassSplitRule(lg), ]}',
      ),
    );
    expect(classic(file)).toContain(
      flatNorm('<View style={[styles.splitDetail, { borderColor: c.hair }]}>'),
    );
  });

  // Mutation caught: the capsule's word back at Classic's 13 in glass.
  it("Bundles' Refresh capsule says its word at 15 in Liquid Glass", () => {
    const file = 'app/bundles/index.tsx';
    expect(code(file)).toContain(flatNorm('lg && [lg.font.displaySemi, GLASS_NAV_CAPSULE_LABEL]'));
  });
});
