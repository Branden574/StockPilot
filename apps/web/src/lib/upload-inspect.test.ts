import { deflateRawSync, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { THREAT_MESSAGES } from './document-threat-scan';
import {
  FAMILY_OF_THREAT,
  inspectOfficeContainer,
  inspectUpload,
  inspectUploadPrefix,
  looksLikeText,
  MAX_OFFICE_PARTS,
  MIME_FOR_UPLOAD_KIND,
  sniffVideoContainer,
} from './upload-inspect';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): the app's own file checks, as one
// pure verdict. Every fixture is a tiny made-up file built here (the
// repository is public): no real malware, no test string of any antivirus
// product, no working exploit. A "macro" is a part NAME in a ZIP directory,
// never code; a "script" is a PDF name token with nothing behind it.
// ---------------------------------------------------------------------------

const ascii = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

function png(): Uint8Array {
  const ihdr = new Uint8Array(25);
  ihdr.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(ihdr.buffer).setUint32(8, 2);
  new DataView(ihdr.buffer).setUint32(12, 3);
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ihdr,
    [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
  );
}

function jpeg(): Uint8Array {
  // SOI, a SOF0 of 3 by 2, EOI.
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

const pdf = (body = '<< /Type /Page >>') =>
  ascii(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${body}\n%%EOF\n`);

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const mp4 = (major = 'isom', compatible = ['isom', 'mp41']) =>
  concat(
    be32(16 + compatible.length * 4),
    ascii('ftyp'),
    ascii(major),
    [0, 0, 2, 0],
    ...compatible.map(ascii),
    be32(8),
    ascii('moov'),
  );
const webm = (docType = 'webm') =>
  concat(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01],
    [0x42, 0x82, 0x80 | docType.length],
    ascii(docType),
    [0x18, 0x53, 0x80, 0x67],
  );

/** A ZIP built here: stored or deflated entries, a central directory, an end record. */
function zip(
  files: Array<{ name: string; body: string; deflate?: boolean; flags?: number }>,
  opts: { leading?: Uint8Array; zip64?: boolean } = {},
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = opts.leading?.byteLength ?? 0;
  for (const f of files) {
    const name = ascii(f.name);
    const raw = ascii(f.body);
    const data = f.deflate ? new Uint8Array(deflateRawSync(Buffer.from(raw))) : raw;
    const method = f.deflate ? 8 : 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, f.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, f.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = concat(...centrals);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, opts.zip64 ? 0xffff : files.length, true);
  ev.setUint16(10, opts.zip64 ? 0xffff : files.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concat(opts.leading ?? new Uint8Array(0), ...locals, cd, end);
}

const TYPES = '<?xml version="1.0"?><Types><Default Extension="xml" ContentType="application/xml"/></Types>';
const docx = (extra: Array<{ name: string; body: string; deflate?: boolean }> = [], types = TYPES) =>
  zip([
    { name: '[Content_Types].xml', body: types, deflate: true },
    { name: 'word/document.xml', body: '<w:document/>' },
    ...extra,
  ]);
const xlsx = (extra: Array<{ name: string; body: string }> = []) =>
  zip([
    { name: '[Content_Types].xml', body: TYPES },
    { name: 'xl/workbook.xml', body: '<workbook/>' },
    ...extra,
  ]);

describe('inspectUpload: the kind comes from the bytes, among the kinds a path accepts', () => {
  it('a clean file of each kind passes, named by its bytes', () => {
    expect(inspectUpload(png(), { accept: ['png', 'jpeg'] })).toEqual({
      ok: true,
      kind: 'png',
      mime: 'image/png',
      width: 2,
      height: 3,
    });
    expect(inspectUpload(jpeg(), { accept: ['png', 'jpeg'] })).toMatchObject({ ok: true, kind: 'jpeg' });
    expect(inspectUpload(pdf(), { accept: ['pdf'] })).toMatchObject({ ok: true, kind: 'pdf', mime: 'application/pdf' });
    expect(inspectUpload(mp4(), { accept: ['mp4', 'quicktime', 'webm'] })).toMatchObject({ ok: true, kind: 'mp4' });
    expect(inspectUpload(webm(), { accept: ['mp4', 'quicktime', 'webm'] })).toMatchObject({ ok: true, kind: 'webm' });
    expect(inspectUpload(docx(), { accept: ['docx'] })).toMatchObject({ ok: true, kind: 'docx' });
    expect(inspectUpload(xlsx(), { accept: ['xlsx'] })).toMatchObject({ ok: true, kind: 'xlsx' });
    expect(inspectUpload(ascii('isbn,title\n978,x\n'), { accept: ['text'] })).toMatchObject({
      ok: true,
      kind: 'text',
    });
  });

  it('a file of a kind the path does not take is the wrong type, whatever it is', () => {
    expect(inspectUpload(pdf(), { accept: ['png', 'jpeg'] })).toEqual({
      ok: false,
      family: 'wrong_type',
      code: 'not_accepted_kind',
    });
    expect(inspectUpload(png(), { accept: ['pdf'] })).toMatchObject({ family: 'wrong_type' });
    expect(inspectUpload(ascii('<!DOCTYPE html><p>x</p>'), { accept: ['png', 'pdf'] })).toMatchObject({
      family: 'wrong_type',
    });
    expect(inspectUpload(new Uint8Array(0), { accept: ['png', 'pdf'] })).toMatchObject({ family: 'wrong_type' });
  });

  it('a declared type the bytes do not bear out is the wrong type', () => {
    expect(inspectUpload(png(), { accept: ['png', 'jpeg'], declaredMime: 'image/jpeg' })).toEqual({
      ok: false,
      family: 'wrong_type',
      code: 'not_declared_kind',
    });
    expect(inspectUpload(png(), { accept: ['png'], declaredMime: 'image/png' })).toMatchObject({ ok: true });
  });

  it("a PDF's header: at the start, unless the path keeps the first-kilobyte rule (the PO import)", () => {
    const late = concat(ascii('x'.repeat(100)), pdf());
    expect(inspectUpload(late, { accept: ['pdf'] })).toMatchObject({ family: 'wrong_type' });
    expect(inspectUpload(late, { accept: ['pdf'], pdfHeader: 'in_first_kilobyte' })).toMatchObject({
      ok: true,
      kind: 'pdf',
    });
    const tooLate = concat(ascii('x'.repeat(2000)), pdf());
    expect(inspectUpload(tooLate, { accept: ['pdf'], pdfHeader: 'in_first_kilobyte' })).toMatchObject({
      family: 'wrong_type',
    });
  });
});

describe('inspectUpload: the scanner verdicts, by family', () => {
  it.each([
    ['a script name token', '/S /JavaScript', 'active_content'],
    ['a launch action', '/S /Launch', 'active_content'],
    ['rich media', '/Subtype /RichMedia', 'active_content'],
    ['an embedded file', '/Type /EmbeddedFile', 'hidden_file'],
    ['a locked PDF', '/Encrypt 5 0 R', 'could_not_check'],
  ] as const)('a PDF with %s: %s', (_what, body, family) => {
    expect(inspectUpload(pdf(`<< ${body} >>`), { accept: ['pdf'] })).toMatchObject({ ok: false, family });
  });

  it('a picture with an archive after its end is a hidden file', () => {
    const bad = concat(png(), [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(inspectUpload(bad, { accept: ['png'] })).toEqual({
      ok: false,
      family: 'hidden_file',
      code: 'appended_payload',
    });
  });

  it('every scanner verdict has one family, and could-not-check covers the three bounds', () => {
    expect(Object.keys(FAMILY_OF_THREAT).sort()).toEqual(Object.keys(THREAT_MESSAGES).sort());
    expect(FAMILY_OF_THREAT.scan_budget).toBe('could_not_check');
    expect(FAMILY_OF_THREAT.pdf_scan_limit).toBe('could_not_check');
    expect(FAMILY_OF_THREAT.pdf_encrypted).toBe('could_not_check');
  });

  it('a stream that inflates past the scan is could-not-check', () => {
    const bomb = deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const doc = concat(
      ascii('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      new Uint8Array(bomb),
      ascii('\nendstream\nendobj\n%%EOF\n'),
    );
    expect(inspectUpload(doc, { accept: ['pdf'] })).toMatchObject({ family: 'could_not_check' });
  });

  it('HEIC is named by its brand', () => {
    const heic = concat(be32(24), ascii('ftypheic'), [0, 0, 0, 0], ascii('mif1heic'));
    expect(inspectUpload(heic, { accept: ['heic'] })).toMatchObject({ ok: true, kind: 'heic' });
  });
});

describe('video containers: the signature only', () => {
  it('MP4 by its brands, QuickTime by qt or an old first atom, WebM by its document type', () => {
    expect(sniffVideoContainer(mp4())).toBe('mp4');
    expect(sniffVideoContainer(mp4('mp42', ['mp42', 'isom']))).toBe('mp4');
    expect(sniffVideoContainer(mp4('qt  ', ['qt  ']))).toBe('quicktime');
    expect(sniffVideoContainer(concat(be32(8), ascii('wide'), be32(16), ascii('mdat')))).toBe('quicktime');
    expect(sniffVideoContainer(webm())).toBe('webm');
  });

  it('an image in the same box format, a Matroska file, and other bytes are not a video', () => {
    expect(sniffVideoContainer(mp4('heic', ['mif1', 'heic']))).toBeNull();
    expect(sniffVideoContainer(mp4('avif', ['avif']))).toBeNull();
    expect(sniffVideoContainer(webm('matroska'))).toBeNull();
    expect(sniffVideoContainer(pdf())).toBeNull();
    expect(sniffVideoContainer(png())).toBeNull();
    expect(sniffVideoContainer(concat(be32(3), ascii('ftypisom')))).toBeNull();
    expect(inspectUpload(png(), { accept: ['mp4', 'quicktime', 'webm'] })).toMatchObject({ family: 'wrong_type' });
  });
});

describe('Word and Excel files: a ZIP of the kind it claims, with no macro part', () => {
  it('a plain document and a plain workbook pass', () => {
    expect(inspectOfficeContainer(docx(), 'docx')).toEqual({ ok: true });
    expect(inspectOfficeContainer(xlsx(), 'xlsx')).toEqual({ ok: true });
    // Printer settings are an ordinary .bin part, not a macro.
    expect(
      inspectOfficeContainer(xlsx([{ name: 'xl/printerSettings/printerSettings1.bin', body: 'x' }]), 'xlsx'),
    ).toEqual({ ok: true });
  });

  it.each([
    ['a VBA project in a document', () => docx([{ name: 'word/vbaProject.bin', body: 'x' }]), 'docx'],
    ['a VBA project in a workbook', () => xlsx([{ name: 'xl/vbaProject.bin', body: 'x' }]), 'xlsx'],
    ['an Excel 4 macro sheet', () => xlsx([{ name: 'xl/macrosheets/sheet1.xml', body: '<x/>' }]), 'xlsx'],
    ['an ActiveX control', () => docx([{ name: 'word/activeX/activeX1.xml', body: '<x/>' }]), 'docx'],
    [
      'a macro content type under another part name',
      () =>
        docx(
          [{ name: 'word/media/image1.png', body: 'x' }],
          '<Types><Override PartName="/word/media/image1.png" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
        ),
      'docx',
    ],
  ] as const)('refused as active content: %s', (_what, build, kind) => {
    expect(inspectUpload(build(), { accept: [kind] })).toEqual({
      ok: false,
      family: 'active_content',
      code: 'office_macro',
    });
  });

  it('a document called a workbook, and a workbook called a document, are the wrong type', () => {
    expect(inspectUpload(docx(), { accept: ['xlsx'] })).toEqual({
      ok: false,
      family: 'wrong_type',
      code: 'office_wrong_parts',
    });
    expect(inspectUpload(xlsx(), { accept: ['docx'] })).toMatchObject({ family: 'wrong_type' });
    // A ZIP with no content-types part is not an Office file at all.
    expect(inspectUpload(zip([{ name: 'word/document.xml', body: 'x' }]), { accept: ['docx'] })).toMatchObject({
      family: 'wrong_type',
    });
  });

  it('an old binary Office file, leading bytes before the ZIP, or a broken directory are the wrong type', () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(inspectUpload(ole, { accept: ['xlsx'] })).toMatchObject({ family: 'wrong_type' });
    const led = zip([{ name: '[Content_Types].xml', body: TYPES }, { name: 'word/document.xml', body: 'x' }], {
      leading: ascii('junk'),
    });
    expect(inspectUpload(led, { accept: ['docx'] })).toMatchObject({ family: 'wrong_type' });
    const cut = docx().subarray(0, 60);
    expect(inspectUpload(cut, { accept: ['docx'] })).toMatchObject({ family: 'wrong_type' });
  });

  it('a ZIP64, an encrypted part, or more parts than it reads: could not be checked', () => {
    expect(inspectUpload(zip([{ name: '[Content_Types].xml', body: TYPES }], { zip64: true }), { accept: ['docx'] }))
      .toMatchObject({ family: 'could_not_check' });
    expect(
      inspectUpload(
        zip([
          { name: '[Content_Types].xml', body: TYPES },
          { name: 'word/document.xml', body: 'x', flags: 1 },
        ]),
        { accept: ['docx'] },
      ),
    ).toMatchObject({ family: 'could_not_check' });
    const many = zip([
      { name: '[Content_Types].xml', body: TYPES },
      { name: 'word/document.xml', body: 'x' },
      ...Array.from({ length: MAX_OFFICE_PARTS }, (_, i) => ({ name: `word/p${i}.xml`, body: '' })),
    ]);
    expect(inspectUpload(many, { accept: ['docx'] })).toMatchObject({ family: 'could_not_check' });
  });
});

describe('text: CSV and TXT', () => {
  it('any text encoding passes; NUL bytes, other control bytes and a PDF do not', () => {
    expect(looksLikeText(ascii('a,b\r\nc,d\t\f\v\x1a'))).toBe(true);
    // A single-byte code page (an accented letter as one byte) is still text.
    expect(looksLikeText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe(true);
    expect(looksLikeText(Buffer.from('café,naïve\n', 'utf8'))).toBe(true);
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
    expect(looksLikeText(ascii('a,b\0'))).toBe(false);
    expect(looksLikeText(Uint8Array.from([0xff, 0xfe, 0x61, 0x00]))).toBe(false);
    expect(looksLikeText(ascii('a\x01b'))).toBe(false);
    expect(looksLikeText(ascii('%PDF-1.7\nhello'))).toBe(false);
    expect(looksLikeText(png())).toBe(false);
    expect(inspectUpload(png(), { accept: ['text'] })).toEqual({ ok: false, family: 'wrong_type', code: 'not_text' });
  });
});

describe('inspectUploadPrefix: the first look a finalize takes', () => {
  it('answers images, PDF and video from leading bytes, and never text or Office kinds', () => {
    expect(inspectUploadPrefix(png(), { accept: ['png'] })).toMatchObject({ ok: true, kind: 'png' });
    expect(inspectUploadPrefix(pdf().subarray(0, 8), { accept: ['pdf'] })).toMatchObject({ ok: true });
    expect(inspectUploadPrefix(mp4().subarray(0, 32), { accept: ['mp4'] })).toMatchObject({ ok: true });
    expect(inspectUploadPrefix(ascii('a,b'), { accept: ['text'] })).toMatchObject({ family: 'wrong_type' });
    expect(inspectUploadPrefix(docx(), { accept: ['docx'] })).toMatchObject({ family: 'wrong_type' });
    expect(inspectUploadPrefix(png(), { accept: ['png'], declaredMime: 'image/webp' })).toMatchObject({
      code: 'not_declared_kind',
    });
  });

  it('every kind has the MIME it is stored as', () => {
    expect(MIME_FOR_UPLOAD_KIND.quicktime).toBe('video/quicktime');
    expect(MIME_FOR_UPLOAD_KIND.docx).toMatch(/wordprocessingml/);
    expect(MIME_FOR_UPLOAD_KIND.heic).toBe('image/heic');
  });
});
