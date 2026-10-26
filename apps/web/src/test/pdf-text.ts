import { inflateSync } from 'node:zlib';

/**
 * The text a @react-pdf document draws, in draw order, for tests that need to
 * read a rendered page (moved here from packing-slip-warehouse.test.ts so the
 * pick slip's tests can read theirs too).
 *
 * Every text run lands in a FlateDecode content stream, and each run is drawn
 * as hex-string glyph codes (`[<53>…] TJ` / `<5369…> Tj`), so raw bytes never
 * contain the strings the page draws. Inflate every stream…endstream section
 * that decompresses cleanly, then decode every hex string back to characters.
 *
 * Only for documents set in a standard-14 font (Helvetica, WinAnsi-encoded),
 * where the glyph codes ARE the character codes: both order slips are. A
 * registered (embedded) font draws glyph ids instead, and this would return
 * noise for it.
 */
export function extractPdfText(pdf: Buffer): string {
  const streams: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = pdf.indexOf('stream', cursor);
    if (start === -1) break;
    // Skip the keyword + the EOL that follows it (\r\n or \n per spec).
    let dataStart = start + 'stream'.length;
    if (pdf[dataStart] === 0x0d) dataStart += 1;
    if (pdf[dataStart] === 0x0a) dataStart += 1;
    const end = pdf.indexOf('endstream', dataStart);
    if (end === -1) break;
    try {
      streams.push(inflateSync(pdf.subarray(dataStart, end)).toString('latin1'));
    } catch {
      // Not a flate stream (font file, image, …) — skip it.
    }
    cursor = end + 'endstream'.length;
  }
  return (streams.join('\n').match(/<[0-9a-fA-F]+>/g) ?? [])
    .map((h) =>
      (h.slice(1, -1).match(/.{2}/g) ?? [])
        .map((b) => String.fromCharCode(parseInt(b, 16)))
        .join(''),
    )
    .join('');
}
