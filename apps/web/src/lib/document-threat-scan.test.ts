import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  SCAN_TIME_BUDGET_MS,
  SCAN_WORK_BUDGET_BYTES,
  scanDocumentBytes,
  THREAT_MESSAGES,
  type DocumentThreatCode,
} from './document-threat-scan';
import { sniffFile } from './file-signature';

// ---------------------------------------------------------------------------
// FIXTURES ARE COMPLETE FILES HERE, not the header-only ones in
// image-signature.test.ts. That module's builders stop after the dimensions —
// which is all `sniffImage` reads — so a PNG from `pngBytes()` has no IEND and
// a WebP has a zero RIFF length. This scanner's whole subject is what comes
// AFTER the end of the image, so a fixture with no end tests nothing.
//
// (Reusing an ill-fitting fixture is how the file-signature suite first passed
// for the wrong reason. Different question, different fixture.)
// ---------------------------------------------------------------------------

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

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

/** A complete PNG: signature, IHDR, IEND (length, tag, empty data, CRC). */
function completePng(): Uint8Array {
  const ihdr = new Uint8Array(25);
  ihdr.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(ihdr.buffer).setUint32(8, 2); // width
  new DataView(ihdr.buffer).setUint32(12, 3); // height
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ihdr,
    [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
  );
}

/** A complete JPEG: SOI, one SOF0 carrying dimensions, EOI. */
function completeJpeg(): Uint8Array {
  return concat(
    [0xff, 0xd8],
    [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00],
    [0xff, 0xd9],
  );
}

/** A complete WebP whose RIFF length actually covers its payload. */
function completeWebp(): Uint8Array {
  const payload = concat(ascii('WEBP'), ascii('VP8 '), [0x04, 0x00, 0x00, 0x00], [1, 2, 3, 4]);
  const header = new Uint8Array(8);
  header.set(ascii('RIFF'));
  new DataView(header.buffer).setUint32(4, payload.length, true); // little-endian
  return concat(header, payload);
}

/**
 * A PDF assembled from real syntax, with `body` dropped in as object content.
 * Not a valid xref table — nothing here parses the xref, and building a
 * byte-accurate one would test the fixture rather than the scanner.
 */
function pdf(body: string): Uint8Array {
  return Uint8Array.from(
    ascii(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n${body}\n%%EOF\n`),
  );
}

/** A PDF whose only copy of `body` lives inside a FlateDecode stream — the
 *  shape every modern producer emits, and the one a raw grep cannot see. */
function pdfWithFlateStream(body: string): Uint8Array {
  const deflated = deflateSync(Buffer.from(body, 'latin1'));
  return concat(
    ascii('%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n'),
    new Uint8Array(deflated),
    ascii('\nendstream\nendobj\n%%EOF\n'),
  );
}

function expectThreat(bytes: Uint8Array, kind: Parameters<typeof scanDocumentBytes>[1]) {
  const threat = scanDocumentBytes(bytes, kind);
  expect(threat, 'expected a threat, got clean').not.toBeNull();
  return threat!;
}

describe('scanDocumentBytes — PDF active content', () => {
  it('passes an ordinary purchase-order PDF', () => {
    const clean = pdf(
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    );
    expect(scanDocumentBytes(clean, 'pdf')).toBeNull();
  });

  it('rejects embedded JavaScript', () => {
    const t = expectThreat(pdf('5 0 obj\n<< /S /JavaScript /JS (app.alert\\(1\\)) >>\nendobj'), 'pdf');
    expect(t.code).toBe('pdf_javascript');
  });

  it('rejects a /Launch action', () => {
    const t = expectThreat(
      pdf('5 0 obj\n<< /S /Launch /F (cmd.exe) >>\nendobj'),
      'pdf',
    );
    expect(t.code).toBe('pdf_launch_action');
  });

  it('rejects an embedded file — the standard malware carrier', () => {
    const t = expectThreat(
      pdf('5 0 obj\n<< /Type /Filespec /EF << /F 6 0 R >> >>\nendobj\n6 0 obj\n<< /Type /EmbeddedFile >>\nendobj'),
      'pdf',
    );
    expect(t.code).toBe('pdf_embedded_file');
  });

  it('rejects the /EmbeddedFiles name tree as well as the singular subtype', () => {
    // Exact-name comparison, so the plural is genuinely a separate entry —
    // this is here because "the singular covers it" is the natural assumption
    // and it is wrong.
    const t = expectThreat(pdf('<< /Names << /EmbeddedFiles 7 0 R >> >>'), 'pdf');
    expect(t.code).toBe('pdf_embedded_file');
  });

  it('rejects rich media', () => {
    expect(expectThreat(pdf('<< /Subtype /RichMedia >>'), 'pdf').code).toBe('pdf_rich_media');
    expect(expectThreat(pdf('<< /Subtype /Movie >>'), 'pdf').code).toBe('pdf_rich_media');
  });

  it('refuses an encrypted PDF rather than reporting clean on what it cannot read', () => {
    // The important half of this is the POSTURE: with encrypted streams every
    // other check is blind, so "no threat found" would mean "did not look".
    const t = expectThreat(pdf('trailer\n<< /Encrypt 9 0 R /Root 1 0 R >>'), 'pdf');
    expect(t.code).toBe('pdf_encrypted');
  });

  // ═══ THE TWO TESTS THAT DECIDE WHETHER THIS SCANNER IS REAL ═══

  it('sees through #xx name escapes — /J#61vaScript is /JavaScript', () => {
    const evasive = pdf('5 0 obj\n<< /S /J#61#76#61#53#63#72#69#70#74 >>\nendobj');
    // Prove the fixture actually evades the naive check this replaces, so the
    // test cannot quietly stop exercising the decode.
    expect(Buffer.from(evasive).toString('latin1')).not.toContain('/JavaScript');
    expect(expectThreat(evasive, 'pdf').code).toBe('pdf_javascript');
  });

  it('sees inside FlateDecode streams — where real producers put everything', () => {
    const hidden = pdfWithFlateStream('<< /S /JavaScript /JS (this.exportDataObject\\(\\)) >>');
    expect(Buffer.from(hidden).toString('latin1')).not.toContain('JavaScript');
    const t = expectThreat(hidden, 'pdf');
    expect(t.code).toBe('pdf_javascript');
    expect(t.detail).toContain('compressed stream');
  });

  it('handles a CRLF between `stream` and its data', () => {
    // Off by the one byte of a CR and the zlib header is corrupt, the inflate
    // throws, the stream is skipped, and the scan reports CLEAN on a file it
    // never decompressed. Both EOL forms are legal, so both are pinned.
    const deflated = deflateSync(Buffer.from('<< /S /Launch >>', 'latin1'));
    const crlf = concat(
      ascii('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\r\n'),
      new Uint8Array(deflated),
      ascii('\nendstream\n%%EOF\n'),
    );
    expect(expectThreat(crlf, 'pdf').code).toBe('pdf_launch_action');
  });

  // ═══ FALSE POSITIVES — the failure mode that gets the guard switched off ═══

  it('accepts a benign /OpenAction, which is most of them', () => {
    // /OpenAction is usually "open on page 1". Rejecting it would refuse a
    // large share of ordinary invoices and teach everyone to distrust the
    // refusal message.
    const goTo = pdf('<< /OpenAction [3 0 R /XYZ null null 0] /Type /Catalog >>');
    expect(scanDocumentBytes(goTo, 'pdf')).toBeNull();
  });

  it('accepts a fillable form and a hyperlinked invoice', () => {
    const form = pdf(
      '<< /AcroForm << /Fields [10 0 R] >> >>\n' +
        '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://vendor.example/pay) >> >>',
    );
    expect(scanDocumentBytes(form, 'pdf')).toBeNull();
  });

  it('is not fooled into a hit by a font subset tag', () => {
    const fonts = pdf('<< /BaseFont /JSABCD+Helvetica /Type /Font /Subtype /TrueType >>');
    expect(scanDocumentBytes(fonts, 'pdf')).toBeNull();
  });
});

describe('scanDocumentBytes — resource bounds are verdicts, not shrugs', () => {
  it('REFUSES a zip bomb rather than decompressing it', () => {
    // 64 MB of zeroes deflates to a few kilobytes. zlib aborts at the ceiling
    // instead of allocating the 64 MB — and the abort is reported as a
    // refusal, because content existed that we chose not to read.
    const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024, 0));
    expect(bomb.byteLength).toBeLessThan(200 * 1024);
    const doc = concat(
      ascii('%PDF-1.7\nstream\n'),
      new Uint8Array(bomb),
      ascii('\nendstream\n%%EOF\n'),
    );
    const started = process.hrtime.bigint();
    expect(expectThreat(doc, 'pdf').code).toBe('pdf_scan_limit');
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5000);
  });

  it('REFUSES a document made of more streams than it will inspect', () => {
    const junk = concat(...Array.from({ length: 5000 }, () => ascii('stream\nxx\nendstream\n')));
    const doc = concat(ascii('%PDF-1.7\n'), junk, ascii('%%EOF\n'));
    expect(expectThreat(doc, 'pdf').code).toBe('pdf_scan_limit');
  });

  // ═══ THE HOLE THIS POSTURE EXISTS TO CLOSE ═══

  it('does not let a payload hide BEHIND the size limit', () => {
    // The first cut of this scanner skipped an over-budget stream and carried
    // on. That turns every bound into a hiding place: pad past the cap with
    // filler that costs nothing to compress, put the JavaScript after the
    // padding, and the scanner declines to look and then reports clean.
    //
    // The assertion is NOT that we find the JavaScript — we deliberately never
    // decompress far enough to see it. It is that we refuse the file anyway,
    // because "could not inspect" must never return the same verdict as
    // "inspected and found nothing".
    const hidden = deflateSync(
      Buffer.concat([
        Buffer.alloc(48 * 1024 * 1024, 0x20),
        Buffer.from('<< /S /JavaScript /JS (payload) >>', 'latin1'),
      ]),
    );
    const doc = concat(
      ascii('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      new Uint8Array(hidden),
      ascii('\nendstream\n%%EOF\n'),
    );
    expect(expectThreat(doc, 'pdf').code).toBe('pdf_scan_limit');
  });

  // ═══ THE SECOND HOLE: THE TOTAL BUDGET, NOT THE PER-STREAM ONE ═══

  it('REFUSES once the TOTAL inflate budget is spent — a payload behind eight cap-sized streams cannot hide', () => {
    // Eight streams that each inflate to exactly the per-stream ceiling spend
    // the whole 256 MiB document budget without any single one tripping it.
    // The ninth stream — the JavaScript — then arrived at zlib with
    // `maxOutputLength: 0`, which Node rejects with ERR_OUT_OF_RANGE, and the
    // old catch filed that under "not Flate" and moved on: the scanner
    // reported CLEAN on a file whose active content it never read.
    // Reproduced 2026-09-02 against the real module. The verdict must be the
    // same refusal the per-stream cap gives: we did not look, so we do not
    // say clean.
    const filler = deflateSync(Buffer.alloc(32 * 1024 * 1024, 0x20));
    expect(filler.byteLength).toBeLessThan(64 * 1024);
    const fillers = Array.from({ length: 8 }, (_, i) =>
      concat(
        ascii(`${i + 1} 0 obj\n<< /Filter /FlateDecode >>\nstream\n`),
        new Uint8Array(filler),
        ascii('\nendstream\nendobj\n'),
      ),
    );
    const js = deflateSync(Buffer.from('<< /S /JavaScript /JS (app.alert(1)) >>', 'latin1'));
    const doc = concat(
      ascii('%PDF-1.7\n'),
      ...fillers,
      ascii('9 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      new Uint8Array(js),
      ascii('\nendstream\nendobj\n%%EOF\n'),
    );
    expect(expectThreat(doc, 'pdf').code).toBe('pdf_scan_limit');
  });

  it('still SEES a payload while budget remains — the refusal above is not over-eager', () => {
    // Seven cap-sized fillers leave 32 MiB of budget; the JavaScript stream
    // must be inflated and found, not refused. This pins the boundary so a
    // future "refuse if budget is low" cannot quietly reject honest documents.
    const filler = deflateSync(Buffer.alloc(32 * 1024 * 1024, 0x20));
    const fillers = Array.from({ length: 7 }, (_, i) =>
      concat(
        ascii(`${i + 1} 0 obj\n<< /Filter /FlateDecode >>\nstream\n`),
        new Uint8Array(filler),
        ascii('\nendstream\nendobj\n'),
      ),
    );
    const js = deflateSync(Buffer.from('<< /S /JavaScript /JS (app.alert(1)) >>', 'latin1'));
    const doc = concat(
      ascii('%PDF-1.7\n'),
      ...fillers,
      ascii('8 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      new Uint8Array(js),
      ascii('\nendstream\nendobj\n%%EOF\n'),
    );
    expect(expectThreat(doc, 'pdf').code).toBe('pdf_javascript');
  });

  it('a truncated Flate run is still "not Flate", not a refusal', () => {
    // Z_BUF_ERROR is the honest skip: nothing was concealed, the deflate run
    // simply ends early (a chopped object, a keyword match inside binary).
    // Keeping this a skip is what stops the fail-closed catch from rejecting
    // ordinary PDFs whose binary happens to contain the word "stream".
    const truncated = deflateSync(Buffer.alloc(5000, 0x20)).subarray(0, 10);
    const doc = concat(
      ascii('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      new Uint8Array(truncated),
      ascii('\nendstream\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n'),
    );
    expect(scanDocumentBytes(doc, 'pdf')).toBeNull();
  });

  it('still skips silently over data that is simply not Flate', () => {
    // A /DCTDecode JPEG, a font program, or the word "endstream" landing
    // inside binary data. Nothing was concealed — there was nothing to
    // decompress — so these must NOT be confused with the refusal above, or
    // every scanned invoice in the system would be rejected.
    const jpegStream = concat(
      ascii('%PDF-1.7\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\n'),
      completeJpeg(),
      ascii('\nendstream\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n'),
    );
    expect(scanDocumentBytes(jpegStream, 'pdf')).toBeNull();
  });
});

describe('scanDocumentBytes — payloads appended to images', () => {
  it('accepts clean images of every format it understands', () => {
    expect(scanDocumentBytes(completePng(), 'png')).toBeNull();
    expect(scanDocumentBytes(completeJpeg(), 'jpeg')).toBeNull();
    expect(scanDocumentBytes(completeWebp(), 'webp')).toBeNull();
  });

  it('rejects a ZIP concatenated onto a PNG', () => {
    // `cat photo.png payload.zip > photo.png` — valid image to every viewer,
    // valid archive to every archive tool, because ZIP readers scan backwards
    // from the end of the file.
    const t = expectThreat(concat(completePng(), ascii('PKrest-of-archive')), 'png');
    expect(t.code).toBe('appended_payload');
    expect(t.detail).toContain('ZIP');
  });

  it('rejects an executable concatenated onto a JPEG', () => {
    const t = expectThreat(concat(completeJpeg(), ascii('MZ payload')), 'jpeg');
    expect(t.code).toBe('appended_payload');
  });

  it('rejects a ZIP concatenated onto a WebP', () => {
    expect(expectThreat(concat(completeWebp(), ascii('PKx')), 'webp').code).toBe(
      'appended_payload',
    );
  });

  it('ACCEPTS ordinary trailing bytes — padding is not a payload', () => {
    // The check keys on a recognised signature, never on the mere existence of
    // trailing data. Cameras and editors leave padding and thumbnails past the
    // marker constantly; rejecting those would refuse a large share of real
    // phone photos and the guard would have to be turned off.
    const padded = concat(completePng(), new Uint8Array(4096).fill(0x20));
    expect(scanDocumentBytes(padded, 'png')).toBeNull();
  });

  it('does not treat a chance MZ deep in trailing data as an executable', () => {
    // MZ is two bytes, so it turns up in noise. It counts only at offset 0 of
    // the trailing run, which is exactly where concatenation puts it — the
    // difference between a signature and a coin toss.
    const noisy = concat(completeJpeg(), [0x00, 0x11, 0x22], ascii('MZ'), [0x33]);
    expect(scanDocumentBytes(noisy, 'jpeg')).toBeNull();
  });

  it('says nothing about HEIC rather than guessing', () => {
    // ISO-BMFF has no terminator; the end is only knowable by walking every
    // box. Returning null here means "cannot say", and the sniffer has already
    // established the file is what it claims.
    const heic = concat([0x00, 0x00, 0x00, 0x18], ascii('ftypheic'), new Uint8Array(16));
    expect(scanDocumentBytes(heic, 'heic')).toBeNull();
  });
});

describe('the scanner and the sniffer agree on what they are looking at', () => {
  it('every fixture the scanner clears also sniffs as the kind it was scanned as', () => {
    // Guards the seam: callers sniff first and pass the sniffed kind here. If
    // a fixture sniffs as something else, the scan above ran the wrong branch
    // and its verdict means nothing.
    for (const [bytes, kind] of [
      [completePng(), 'png'],
      [completeJpeg(), 'jpeg'],
      [completeWebp(), 'webp'],
      [pdf('<< /Type /Page >>'), 'pdf'],
    ] as const) {
      expect(sniffFile(bytes)?.kind, `fixture for ${kind}`).toBe(kind);
    }
  });

  it('every threat code has a message that tells the uploader what to do', () => {
    const codes: DocumentThreatCode[] = [
      'pdf_javascript',
      'pdf_launch_action',
      'pdf_embedded_file',
      'pdf_rich_media',
      'pdf_encrypted',
      'pdf_scan_limit',
      'appended_payload',
      'scan_budget',
    ];
    expect(Object.keys(THREAT_MESSAGES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(THREAT_MESSAGES[code], code).toBeTruthy();
      // The PDF refusals must name a way forward; a dead end turns a safe
      // refusal into a support ticket.
      if (code.startsWith('pdf_')) expect(THREAT_MESSAGES[code]).toMatch(/Print to PDF/);
    }
  });
});

// ---------------------------------------------------------------------------
// PART 6: THE SCAN HAS A CLOCK AND A TOTAL-WORK CEILING.
//
// Every bound above caps an amount. None capped the time, and inflateSync is
// synchronous, so a document built to be slow held the request for as long as
// it liked. Now the scan reads a clock between steps and counts every byte it
// reads; running out of either is the `scan_budget` verdict, refused like the
// other bounds ("could not be checked" is never "clean"). The budgets are
// overridable only so these tests can spend them without minutes of work.
// ---------------------------------------------------------------------------
describe('scanDocumentBytes: the time and total-work budgets (part 6)', () => {
  /** A clock that moves `step` milliseconds every time it is read. */
  const ticking = (step: number) => {
    let t = 0;
    return () => {
      t += step;
      return t;
    };
  };
  /** A PDF of `n` small Flate streams with nothing active in them. */
  const manyStreams = (n: number): Uint8Array => {
    const body = deflateSync(Buffer.from('<< /Type /Page >>', 'latin1'));
    return concat(
      ascii('%PDF-1.7\n'),
      ...Array.from({ length: n }, (_, i) =>
        concat(
          ascii(`${i + 1} 0 obj\n<< /Filter /FlateDecode >>\nstream\n`),
          new Uint8Array(body),
          ascii('\nendstream\nendobj\n'),
        ),
      ),
      ascii('%%EOF\n'),
    );
  };

  it('the budgets: four seconds, and 512 MiB of bytes read', () => {
    expect(SCAN_TIME_BUDGET_MS).toBe(4_000);
    expect(SCAN_WORK_BUDGET_BYTES).toBe(512 * 1024 * 1024);
  });

  it('a clock that runs out between streams is a refusal: could not be checked', () => {
    const doc = manyStreams(40);
    expect(scanDocumentBytes(doc, 'pdf')).toBeNull();
    const threat = scanDocumentBytes(doc, 'pdf', { timeBudgetMs: 100, now: ticking(10) });
    expect(threat?.code).toBe('scan_budget');
    expect(threat?.detail).toBe('time budget spent');
  });

  it('a clock that does not run out changes nothing: the same verdicts as before', () => {
    const still = () => 0;
    expect(scanDocumentBytes(manyStreams(40), 'pdf', { now: still })).toBeNull();
    expect(
      scanDocumentBytes(pdfWithFlateStream('<< /S /JavaScript /JS (x) >>'), 'pdf', { now: still })
        ?.code,
    ).toBe('pdf_javascript');
    expect(scanDocumentBytes(completePng(), 'png', { now: still })).toBeNull();
  });

  it('the work ceiling refuses a PDF, and an image whose trailer it cannot finish reading', () => {
    const doc = manyStreams(5);
    expect(scanDocumentBytes(doc, 'pdf', { workBudgetBytes: 10 })?.code).toBe('scan_budget');
    // Enough for the document's own passes, not for its streams.
    expect(
      scanDocumentBytes(doc, 'pdf', { workBudgetBytes: doc.byteLength * 3 + 20 })?.detail,
    ).toBe('total work budget spent');
    const padded = concat(completePng(), new Uint8Array(4096).fill(0x20));
    expect(scanDocumentBytes(padded, 'png')).toBeNull();
    expect(
      scanDocumentBytes(padded, 'png', { workBudgetBytes: padded.byteLength + 4096 * 2 })?.code,
    ).toBe('scan_budget');
    // A ceiling at least as large as the work: clean, as before.
    expect(scanDocumentBytes(padded, 'png', { workBudgetBytes: padded.byteLength * 8 })).toBeNull();
  });

  it('a hidden payload is still found before the work runs out, when the ceiling allows', () => {
    const zip = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00];
    const bad = concat(completePng(), zip);
    expect(scanDocumentBytes(bad, 'png')?.code).toBe('appended_payload');
  });

  it('keywords with no endstream after them: the verdicts are the old ones, without the old cost', () => {
    // A document whose last part is the word `stream` over and over, with no
    // `endstream` after it: nothing more can be inflated. The old loop searched
    // the rest of the document again for every keyword (the square of its
    // size). The verdict is the same: fewer keywords than the stream ceiling
    // is clean, more is refused (4,012 generated documents gave the old and the
    // new module the same verdict, 2026-11-24, part-6-web/PROGRESS.md).
    const few = concat(ascii('%PDF-1.7\n'), ascii('stream '.repeat(3000)), ascii('%%EOF\n'));
    expect(scanDocumentBytes(few, 'pdf')).toBeNull();
    const many = concat(ascii('%PDF-1.7\n'), ascii('stream '.repeat(5000)), ascii('%%EOF\n'));
    expect(scanDocumentBytes(many, 'pdf')?.code).toBe('pdf_scan_limit');
    // Right at the ceiling, as the old loop answered.
    const at = (n: number) =>
      scanDocumentBytes(concat(ascii('%PDF-1.7\n'), ascii('stream '.repeat(n))), 'pdf');
    expect(at(4095)).toBeNull();
    expect(at(4096)).toBeNull();
    expect(at(4097)?.code).toBe('pdf_scan_limit');
    // And it is quick: four megabytes of keywords is one pass, not thousands.
    const big = concat(ascii('%PDF-1.7\n'), ascii('stream '.repeat(600_000)));
    const started = performance.now();
    expect(scanDocumentBytes(big, 'pdf')?.code).toBe('pdf_scan_limit');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('the refusal sentence gives a way forward and no detail of the check', () => {
    expect(THREAT_MESSAGES.scan_budget).toBe(
      'We could not finish checking this file safely, so it was not uploaded. Save a simpler copy and upload that.',
    );
    expect(THREAT_MESSAGES.scan_budget).not.toMatch(/\d|second|budget|limit|stream/i);
  });
});
