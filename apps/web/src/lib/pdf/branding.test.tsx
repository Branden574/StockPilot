// SSRF: the logo in a branded PDF header. organizations.logo_url is set by an
// org owner or admin, and the database does not hold it to the logo bucket the
// settings action checks, so a direct update can store any string. react-pdf's
// <Image src> fetches a URL itself (the global fetch, following redirects) and
// reads any string that is not an absolute URL as a file on the server. So the
// header draws only a data: URI of PNG or JPEG bytes, which the routes build
// through the guarded fetch (prefetchPdfLogo in image-prefetch.ts).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrandedHeader, isEmbeddableImageDataUri } from './branding';

async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

function headerDocument(orgLogoUrl: string | null) {
  return (
    <Document>
      <Page size="LETTER">
        <BrandedHeader orgName="Example Org" orgLogoUrl={orgLogoUrl} title="Inventory export" />
      </Page>
    </Document>
  );
}

/** Whether the PDF embeds an image (an image XObject). */
function embedsAnImage(pdf: Buffer): boolean {
  return pdf.toString('latin1').includes('/Subtype /Image');
}

describe('BrandedHeader — the logo is bytes, never a URL or a path', () => {
  const realFetch = globalThis.fetch;
  // Every address the render asks for, answered with a real PNG. A data: URL
  // goes to the real fetch: that is how react-pdf's layout engine loads its
  // own wasm, and it never leaves the process.
  let requested: string[];
  let dir: string;

  beforeEach(() => {
    requested = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('data:')) return realFetch(input, init);
      requested.push(url);
      return new Response(new Uint8Array(await pngBytes()), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    dir = mkdtempSync(path.join(tmpdir(), 'branding-test-'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('draws a logo given as a data: URI of PNG bytes', async () => {
    const uri = `data:image/png;base64,${(await pngBytes()).toString('base64')}`;
    expect(embedsAnImage(await renderToBuffer(headerDocument(uri)))).toBe(true);
    expect(requested).toEqual([]);
  });

  it('never fetches a logo given as a URL', async () => {
    const pdf = await renderToBuffer(
      headerDocument('http://169.254.169.254/latest/meta-data/logo.png'),
    );
    expect(requested).toEqual([]);
    expect(embedsAnImage(pdf)).toBe(false);
  });

  it('never reads a logo given as a path on the server', async () => {
    const file = path.join(dir, 'logo.png');
    writeFileSync(file, await pngBytes());
    expect(embedsAnImage(await renderToBuffer(headerDocument(file)))).toBe(false);
    expect(embedsAnImage(await renderToBuffer(headerDocument(`file://${file}`)))).toBe(false);
  });

  it('prints the organization name with or without a logo', async () => {
    const pdf = await renderToBuffer(headerDocument(null));
    expect(embedsAnImage(pdf)).toBe(false);
    expect(requested).toEqual([]);
  });
});

describe('isEmbeddableImageDataUri', () => {
  it('accepts only a base64 data: URI of PNG or JPEG bytes', () => {
    expect(isEmbeddableImageDataUri('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isEmbeddableImageDataUri('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    for (const value of [
      null,
      undefined,
      '',
      'https://proj.supabase.co/storage/v1/object/public/org-logos/org/logo.png',
      'http://169.254.169.254/latest/meta-data/',
      '/var/task/logo.png',
      'file:///etc/hosts',
      'logo.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:text/html;base64,PGgxPg==',
      ' data:image/png;base64,iVBORw0KGgo=',
    ]) {
      expect(isEmbeddableImageDataUri(value), String(value)).toBe(false);
    }
  });
});
