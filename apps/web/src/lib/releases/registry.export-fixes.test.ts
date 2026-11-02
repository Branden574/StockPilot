import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ExcelJS from 'exceljs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { ExportBuilderPreview } from '@/components/inventory/export-builder/export-builder-preview';
import { initialExportBuilderState } from '@/components/inventory/export-builder/export-builder-state';
import type { EmbeddedImage } from '@/lib/exports/export-images';
import { getExportField, type InventoryExportFieldKey } from '@/lib/exports/field-registry';
import { IDENTIFIER_RESERVE_CAP_PT } from '@/lib/exports/pdf-layout';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';
import { toInventoryXlsx } from '@/lib/inventory-export-xlsx';
import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';
import { REPORT_BODY_FONT_SIZE_PT, REPORT_CELL_PADDING_PT } from '@/lib/pdf/column-fit';
import { safeWidth } from '@/lib/pdf/helvetica-metrics';
import { breakIdentifierLines } from '@/lib/pdf/identifier-lines';
import { catalogValueWidthPt } from '@/lib/pdf/inventory-export-pdf';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * The export part of docket C9, #414 (squash 75f5b0fe1, merged 2026-10-31
 * 09:26Z; web only, no migration, no phone code): an Excel export stores a
 * photo several rows share once, a PDF export of Items or Books prints a long
 * SKU, barcode or ISBN whole, and the Customize export dialog says when its
 * sample could not load. #414 kept its What's New draft in its PR body only;
 * docs/whats-new-small-fixes-8 publishes it once web build d8c556a672e3 was
 * live (09:27:52Z) and walked in Demo Co on production (09:33Z to 09:53Z, the
 * check closed 10:10:32Z), above small-fixes-8-2026-10, so one web deploy
 * publishes both.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin what a published release must hold (when it was
 * published, who it reaches, the notice and the old phone builds' list), the
 * screens' own words, and the code each claim rests on.
 */
const ID = 'export-fixes-2026-10';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Whoever can export, in an organization without the Books module. */
const exporter: ReleaseViewer = {
  role: 'staff',
  permissions: ['items:export'],
  enabledModules: [],
};

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
/** A dashboard page's source, by its path under app/(dashboard)/dashboard. */
const page = (rel: string) => source(`app/(dashboard)/dashboard/${rel}`);
/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

/** Every string a reader can see in the release. */
function readerText(r: Release): string[] {
  return [
    r.title,
    r.summary,
    ...r.entries.flatMap((e) => [
      e.title,
      e.area ?? '',
      e.whatChanged,
      e.whyItMatters,
      e.howItAffectsYou,
      e.whatToDo,
      e.link?.label ?? '',
    ]),
  ];
}

/** The Export dialog's sample, drawn as the page draws it. */
function previewMarkup(props: { failed: boolean }): string {
  return renderToStaticMarkup(
    createElement(ExportBuilderPreview, {
      state: initialExportBuilderState('other'),
      itemTypeKind: 'other',
      preview: null,
      failed: props.failed,
      onRetry: () => undefined,
      rowCount: 3,
    }),
  );
}

describe('the export fixes release', () => {
  it('is published after the web deploy, so every feed it reaches carries it, and publishing it changes what clients observe', () => {
    expect(release()).toBeDefined();
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(visibleReleases(RELEASES, everyone).map((r) => r.id)).toContain(ID);
    expect(buildReleaseList(RELEASES, everyone, [], null).releases.map((r) => r.id)).toContain(ID);
    expect(legacyAnnouncementsFor(RELEASES, everyone, {}).map((a) => a.id)).toContain(ID);
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(ID);
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
  });

  // Renamed by fix/b44-update-restart-prompt (2026-10-31; was: "is the newest entry, at the top, directly above the small-fixes-8 release, and dated after every other release on a whole minute", with ID at RELEASES[0], the small-fixes-8 release at RELEASES[1] and every release from RELEASES[1] dated before it): the B44 phone update draft (mobile-app-asks-before-restarting) is dated after every release, at the top, directly above it, so it and the small-fixes-8 release move down by one. Claim kept: directly above the small-fixes-8 release, dated after every release below it, on a whole minute.
  it('sits directly below the B44 phone update draft, directly above the small-fixes-8 release, and is dated after every release below it on a whole minute', () => {
    expect(RELEASES[0]?.id).toBe('mobile-app-asks-before-restarting');
    expect(RELEASES[0]?.status).toBe('draft');
    expect(RELEASES[1]?.id).toBe(ID);
    expect(RELEASES[2]?.id).toBe('small-fixes-8-2026-10');
    for (const r of RELEASES.slice(2)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  });

  // Published once #414 had merged (09:26Z), its web build answered on
  // production (09:27:52Z) and the Demo Co walk's check had closed
  // (10:10:32Z); the day it went live (UTC) is the ceiling.
  it('is published as revision 1, not before its web build was live (09:27:52Z) and walked (to 10:10:32Z), on the day it went live, and no draft is left', () => {
    // Re-pinned by fix/b44-update-restart-prompt (2026-10-31; was: no draft): the B44 phone update draft (mobile-app-asks-before-restarting) is dated after every release, at the top, above the export fixes release, so every position below it moves down by one, and it is the one draft.
    const at = Date.parse(release().publishedAt);
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-10-31T09:26:00Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-10-31T09:27:52Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-10-31T10:10:32Z'));
    expect(at).toBeLessThanOrEqual(Date.parse('2026-11-01T00:00:00Z'));
    expect(release().revision).toBe(1);
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'mobile-app-asks-before-restarting',
    ]);
  });

  // #414's draft had a fourth line, for the header of the branded PDFs; it is
  // left to B48, which announces logos printing again in those headers.
  it('has a line for each user-visible change, in this order, all fixes, and says it is on the web', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'export-excel-photo-once',
      'export-pdf-long-identifiers',
      'export-sample-could-not-load',
    ]);
    expect(release().entries.map((e) => e.id)).not.toContain('pdf-header-unprintable-logo');
    for (const e of release().entries) {
      expect(e.category, e.id).toBe('fixed');
      expect(e.area, e.id).toBe('Inventory');
    }
    // Web only: no phone line, and the summary says so.
    expect(release().summary).toMatch(/^On the web, /);
    expect(readerText(release()).join(' ')).not.toMatch(/mobile app|phone/i);
  });

  // The long SKU line covers the Items PDF too, so it is told in every
  // organization and links to Items, as the other two lines do: a Books link
  // would need the Books module and hide it from every organization without
  // Books (review of this publish).
  it('tells each line to whoever can export, with or without Books, and links each to Items', () => {
    expect(entry('export-excel-photo-once').audience).toEqual({ anyPermission: ['items:export'] });
    expect(entry('export-excel-photo-once').link).toEqual({
      href: '/dashboard/inventory',
      label: 'Open Items',
    });
    expect(entry('export-pdf-long-identifiers').audience).toEqual({
      anyPermission: ['items:export'],
    });
    expect(entry('export-pdf-long-identifiers').link).toEqual({
      href: '/dashboard/inventory',
      label: 'Open Items',
    });
    expect(entry('export-pdf-long-identifiers').whatChanged).toMatch(
      /^In a PDF export of Items or Books, /,
    );
    expect(entry('export-sample-could-not-load').audience).toEqual({
      anyPermission: ['items:export'],
    });
    expect(entry('export-sample-could-not-load').link).toEqual({
      href: '/dashboard/inventory',
      label: 'Open Items',
    });
    expect(release().audience).toBeUndefined();

    const told = (v: ReleaseViewer) =>
      visibleReleases(RELEASES, v)
        .find((r) => r.id === ID)
        ?.entries.map((e) => e.id) ?? [];
    expect(told(everyone)).toEqual(release().entries.map((e) => e.id));
    // Whoever can export is told every line, where Books is off too.
    expect(told(exporter)).toEqual(release().entries.map((e) => e.id));
    expect(told({ ...exporter, enabledModules: ['books'] })).toEqual(
      release().entries.map((e) => e.id),
    );
    // A member who cannot export is not told this release at all.
    expect(told(member)).toEqual([]);
    expect(told({ role: 'staff', permissions: ['items:read'], enabledModules: ['books'] })).toEqual(
      [],
    );
  });

  // Every audience names what its page and the export check: the export and
  // its sample answer only whoever holds items:export, and the Items page,
  // where every line links, checks no permission or module. The Books page
  // checks the Books module, on by default only for the charter school pack,
  // which is why the long SKU line links to Items. Fails if a check changes.
  it('names in each audience the permission and the module the export and its page check', () => {
    expect(source('app/api/inventory/export/route.tsx')).toContain(
      "if (!can(ctx, 'items:export')) {",
    );
    expect(source('app/api/inventory/export/preview/route.ts')).toContain(
      "if (!can(ctx, 'items:export')) {",
    );
    const items = page('inventory/page.tsx');
    expect(items).toContain('requireOrgContext(),');
    expect(items).not.toMatch(
      /checkModuleAccess|ModuleUnavailable|assertPermission|assertModuleEnabled/,
    );
    for (const e of release().entries) {
      expect(e.link?.href, e.id).toBe('/dashboard/inventory');
      expect(e.audience, e.id).toEqual({ anyPermission: ['items:export'] });
    }
    const books = page('books/page.tsx');
    expect(books).toContain("checkModuleAccess('books'),");
    expect(books).toContain('return <ModuleUnavailable moduleId="books" access={moduleAccess} />;');
    expect(MODULE_REGISTRY.books.defaultOnFor).toEqual(['charter_school']);
  });

  // An old phone build shows the title, the summary and the first linked line
  // the reader can reach as its button; the phone draws the button only when
  // the link opens one of its own screens (whats-new.tsx).
  it('is the first notice for whoever can export, and an old phone build shows its title and summary with Open Items', () => {
    for (const v of [everyone, exporter]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0], v.role).toEqual({
        id: ID,
        date: '2026-10-31',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/inventory', label: 'Open Items' },
      });
    }
    // Not told to a member who cannot export.
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).not.toBe(ID);
    expect(legacyAnnouncementsFor(RELEASES, member, {}).map((a) => a.id)).not.toContain(ID);
    // On the phone, Open Items opens its Inventory screen, so the phone shows
    // the button.
    expect(phone('src/components/onboarding/whats-new.tsx')).toContain(
      "const showCta = !!cta && rewriteWebPath(cta.href) !== '/';",
    );
    expect(phone('src/lib/web-path-rewrite.ts')).toContain(
      "{ re: /\\/dashboard\\/inventory(\\?.*)?$/, to: () => '/inventory' },",
    );
  });

  it("uses the screens' own words", () => {
    const text = readerText(release()).join(' ');
    const dialog = source('components/inventory/export-builder/export-builder-dialog.tsx');
    // The dialog's title, its Excel format and its Export file button.
    expect(dialog).toContain('<DialogTitle>Customize export</DialogTitle>');
    expect(text).toContain('Customize export dialog');
    expect(dialog).toContain("label: 'Excel',");
    expect(dialog).toContain("label: 'PDF',");
    expect(dialog).toMatch(
      /disabled=\{busy \|\| !validation\.ok\}>\s*\{busy \?[^\n]*\n\s*Export file\n/,
    );
    expect(text).toContain('choose Export file');
    // The Layout select of a Books PDF export, by its options.
    expect(dialog).toContain('aria-label="Layout"');
    expect(dialog).toContain('<option value="catalog-2">Book catalog — two columns</option>');
    expect(dialog).toContain('<option value="catalog-3">Book catalog — three columns</option>');
    expect(entry('export-pdf-long-identifiers').whatChanged).toContain(
      'With Layout set to Book catalog — two columns or Book catalog — three columns,',
    );
    // Reached from Export on Items and Books: the toolbar's Export menu and
    // the bulk bar's Export both open the dialog, and the Books page draws
    // the Items table.
    const table = source('components/inventory/inventory-table.tsx');
    expect(table).toContain('label="Export"');
    expect(table).toMatch(/<ExportMenu\s/);
    expect(source('components/inventory/bulk-actions.tsx')).toContain(
      '<Download aria-hidden strokeWidth={1.6} /> Export',
    );
    expect(source('components/books/books-inventory-table.tsx')).toContain(
      '<InventoryTable {...props}',
    );
    expect(entry('export-sample-could-not-load').whatChanged).toContain(
      'reached from Export on Items and Books',
    );

    // The sample's message and Try again, quoted as the dialog draws them.
    const failed = previewMarkup({ failed: true });
    const message = /<p role="status"[^>]*>([^<]+)<\/p>/.exec(failed)?.[1];
    expect(message).toBe('Could not load a sample of this export. You can still export the file.');
    expect(entry('export-sample-could-not-load').whatChanged).toContain(`“${message}”`);
    expect(failed).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(entry('export-sample-could-not-load').whatChanged).toContain('offers Try again');
    expect(entry('export-sample-could-not-load').whatToDo).toContain('choose Try again');
    expect(failed).not.toContain('Loading a sample');
    // The line a failed sample kept showing before: the loading line.
    const loading = previewMarkup({ failed: false });
    const loadingLine = /<p [^>]*>(Loading a sample[^<]*)<\/p>/.exec(loading)?.[1];
    expect(loadingLine).toBe('Loading a sample of this export…');
    expect(entry('export-sample-could-not-load').whyItMatters).toContain(`“${loadingLine}”`);
    expect(loading).not.toContain('Try again');
  });

  it('claims nothing the product does not do, and never "book" for a quantity', () => {
    const text = readerText(release()).join(' ');
    // Books (the item type) and the Book catalog layouts only.
    expect(text.replace(/Book catalog — (?:two|three) columns/g, '')).not.toMatch(/\bbook\b/i);
    expect(text).not.toMatch(/\bthe book\b/i);
    // Left out on purpose (see the registry): the header logo, the guarded
    // photo fetch and the cover addresses it leaves blank.
    expect(text).not.toMatch(
      /logo|header|SSRF|redirect|allow.?list|cover address|Open Library|Google Books/i,
    );
    // Older faults found by the walk, not part of #414 (B62, B63).
    expect(text).not.toMatch(/black|transparent|see-through|crash|not found/i);
    // Only the Items and Books export: never every PDF, a slip or a report.
    expect(text).not.toMatch(/\b(?:all|every) PDF|pick slip|packing slip|report/i);
    expect(text).not.toMatch(/\bfaster\b|guarantee|automatically|email/i);
    // Nothing was measured, so no size or number is promised.
    expect(entry('export-excel-photo-once').whyItMatters).toContain(
      'so the file could be much larger than it needed to be.',
    );
    expect(text).not.toMatch(/\d+ ?(?:%|percent|times|MB|KB|GB)/i);
  });
});

/** An Items row for an Excel export, with synthetic values. */
function itemRow(n: number): InventoryExportSourceRow {
  return {
    id: `i-${n}`,
    itemType: 'product',
    name: `Sample item ${n}`,
    sku: `SAMPLE-000${n}`,
    barcode: '',
    status: 'active',
    quantityOnHand: 1,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: null,
    retailPrice: null,
    category: '',
    primaryLocation: '',
    supplier: '',
    warehouse: '',
    charter: 'Generic',
    trackingType: 'none',
    author: '',
    isbn: '',
    grade: '',
    rackNumber: '',
    rackRow: '',
    crateColor: '',
    crateNumber: '',
    rackLabel: '',
    crateLabel: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    image: { thumbnailUrl: `https://photos.example/${n}.png` },
    legacyRawBookFields: {
      grade: '',
      rackNumber: '',
      rackRow: '',
      crateColor: '',
      crateNumber: '',
    },
  };
}

async function solidPng(color: string): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp');
  const buf = await sharp({ create: { width: 2, height: 2, channels: 3, background: color } })
    .png()
    .toBuffer();
  return Uint8Array.from(buf);
}

describe('the export fixes release rests on the code', () => {
  // "When several rows of an Excel export share one photo, the file now holds
  // that photo once instead of once for every row. Every row still shows its
  // own photo." (workbookImages in lib/inventory-export-xlsx.ts)
  it('an Excel export holds a photo several rows share once, and every row still shows its own photo', async () => {
    const shared: EmbeddedImage = { data: await solidPng('#cc2200'), extension: 'png' };
    const other: EmbeddedImage = { data: await solidPng('#2266cc'), extension: 'png' };
    // Row 4's photo is the shared one fetched again: the same bytes.
    const again: EmbeddedImage = { data: Uint8Array.from(shared.data), extension: 'png' };
    const fields: InventoryExportFieldKey[] = ['image', 'name', 'sku'];
    const buffer = await toInventoryXlsx({
      fields: fields.map((k) => getExportField(k)!),
      rows: [1, 2, 3, 4].map(itemRow),
      itemTypeKind: 'other',
      freezeHeader: true,
      autoFilter: true,
      includeSummarySheet: false,
      imageMode: 'embedded',
      imageSize: 'medium',
      images: new Map([
        ['i-1', shared],
        ['i-2', other],
        ['i-3', shared],
        ['i-4', again],
      ]),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    // Two photos, so two files in the workbook, not four.
    const media = (wb.model as unknown as { media: Array<{ buffer: Buffer }> }).media;
    expect(media).toHaveLength(2);
    // Four rows, each with its own picture, showing its own row's photo.
    const placed = wb.worksheets[0]!.getImages();
    expect(placed).toHaveLength(4);
    const shownByRow = new Map(
      placed.map((img) => {
        const file = wb.getImage(Number(img.imageId)) as unknown as { buffer: Buffer };
        const which = [shared, other].findIndex(
          (p) => Buffer.compare(Buffer.from(p.data), Buffer.from(file.buffer)) === 0,
        );
        return [Math.floor(img.range.tl.row), which] as const;
      }),
    );
    expect(shownByRow).toEqual(
      new Map([
        [1, 0],
        [2, 1],
        [3, 0],
        [4, 0],
      ]),
    );
  });

  // "a SKU, barcode or ISBN too long for its space now prints whole over two
  // or more lines, with no hyphen added where a line ends" and "Values that
  // fit print exactly as before." (breakIdentifierLines)
  it('a PDF export breaks a long SKU, barcode or ISBN onto lines that fit and join back to the exact value, and leaves one that fits as it was', () => {
    const fontPt = REPORT_BODY_FONT_SIZE_PT;
    // The widest the table makes a SKU, barcode or ISBN column, less its
    // padding.
    expect(IDENTIFIER_RESERVE_CAP_PT).toBe(150);
    const tableValuePt = IDENTIFIER_RESERVE_CAP_PT - REPORT_CELL_PADDING_PT * 2;
    // What a line of that column holds, as the release's comment says: about
    // 25 capital letters or 30 digits. The table also takes a half point of
    // slack off (FIT_SLACK_PT) and breaks anything longer, such as a
    // 32-character SKU.
    expect(source('lib/pdf/inventory-export-pdf.tsx')).toContain('const FIT_SLACK_PT = 0.5;');
    const tableLinePt = tableValuePt - 0.5;
    expect(breakIdentifierLines('S'.repeat(25), tableLinePt, fontPt)).toBe('S'.repeat(25));
    expect(breakIdentifierLines('S'.repeat(26), tableLinePt, fontPt)).toContain('\n');
    expect(breakIdentifierLines('9'.repeat(30), tableLinePt, fontPt)).toBe('9'.repeat(30));
    expect(breakIdentifierLines('9'.repeat(31), tableLinePt, fontPt)).toContain('\n');
    expect(breakIdentifierLines('MATH-GRADE5-WORKBOOK-2026-ED2-XL', tableLinePt, fontPt)).toContain(
      '\n',
    );
    // The value column of a card in Book catalog — two columns (Letter,
    // portrait) and Book catalog — three columns (Letter, landscape).
    const widths = [tableValuePt, catalogValueWidthPt(612, 2), catalogValueWidthPt(792, 3)];
    for (const w of widths) expect(w).toBeGreaterThan(40);

    // Two of its own hyphens and a 36-digit run.
    const longSku = 'SAMPLE-WORKBOOKEDITION-202610310955123456789012345678901234';
    const hyphens = (s: string) => s.split('-').length - 1;
    for (const w of widths) {
      const out = breakIdentifierLines(longSku, w, fontPt);
      const lines = out.split('\n');
      expect(lines.length, String(w)).toBeGreaterThanOrEqual(2);
      // Whole: the lines join back to the value, nothing added or dropped.
      expect(lines.join(''), String(w)).toBe(longSku);
      expect(hyphens(out), String(w)).toBe(hyphens(longSku));
      for (const line of lines) {
        expect(line.length, String(w)).toBeGreaterThan(0);
        expect(safeWidth(line, 'Helvetica', fontPt), line).toBeLessThanOrEqual(w);
      }
    }
    // A long run of digits is broken too, instead of running past its box.
    const digits = '202610310955123456789012345678901234567890';
    const digitLines = breakIdentifierLines(digits, 60, fontPt).split('\n');
    expect(digitLines.length).toBeGreaterThanOrEqual(2);
    expect(digitLines.join('')).toBe(digits);
    // A line ends just after the value's own separator when one falls on it.
    expect(
      breakIdentifierLines('MATH-GRADE5-WORKBOOK-2026-ED2-XL', 60, fontPt).split('\n')[0],
    ).toMatch(/-$/);
    // A value that fits comes back unchanged.
    for (const value of ['SAMPLE-0001', '9780000000002']) {
      expect(breakIdentifierLines(value, tableValuePt, fontPt)).toBe(value);
    }
  });

  // The table and the catalog both break identifiers this way, and only
  // identifiers: SKU, barcode and ISBN. The catalog's card widths come from
  // the page, so a long title or value stays in its card and clear of the
  // cover (lib/pdf/inventory-export-pdf.tsx).
  it('the Items and Books PDF export uses it for the SKU, barcode and ISBN in the table and the catalog, and sizes catalog cards from the page', () => {
    const identifiers = (['sku', 'barcode', 'isbn', 'name', 'category'] as const).filter(
      (k) => getExportField(k)?.identifier === true,
    );
    expect(identifiers).toEqual(['sku', 'barcode', 'isbn']);
    expect(source('lib/exports/pdf-layout.ts')).toContain('clip: f.identifier === true,');
    const pdf = source('lib/pdf/inventory-export-pdf.tsx');
    expect(pdf).toMatch(/col\.clip \? \([\s\S]{0,400}\{breakIdentifierLines\(/);
    expect(pdf).toMatch(/\{field\.identifier\s*\? breakIdentifierLines\(/);
    expect(pdf).toContain('catalogValueWidthPt(layout.pageWidthPt, catalog.columns)');
    expect(pdf).toMatch(/cardBody: \{\s*flexGrow: 1,\s*flexBasis: 0,/);
    expect(pdf).toMatch(/cardValue: \{[^}]*flexBasis: 0,/);
    expect(pdf).toContain('<View style={{ width: cover.widthPt, minWidth: cover.widthPt }}>');
  });
});
