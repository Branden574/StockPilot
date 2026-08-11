import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PdfTooLargeError,
  assemblePdf,
  routeScannedPages,
  scanFileName,
} from './document-scanner';
import { resizeForUpload } from './image-resize';

// Native/Expo modules never load in vitest — everything document-scanner.ts
// touches is mocked here. The scanner plugin itself is only ever imported
// lazily inside scanDocumentPages(), so it stays out of collection entirely
// (mocked per-test with vi.doMock below).
// Module id must stay in lockstep with document-scanner.ts's own import
// specifier — 'expo-file-system/legacy' since SDK 54 (the URI-string API moved
// there; the same names on the default export throw at runtime).
vi.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  readAsStringAsync: vi.fn(),
  getInfoAsync: vi.fn(),
}));
vi.mock('expo-print', () => ({
  printToFileAsync: vi.fn(),
}));
vi.mock('./image-resize', () => ({
  resizeForUpload: vi.fn(),
}));

const mockResize = vi.mocked(resizeForUpload);
const mockReadBase64 = vi.mocked(FileSystem.readAsStringAsync);
const mockGetInfo = vi.mocked(FileSystem.getInfoAsync);
const mockPrint = vi.mocked(Print.printToFileAsync);

const MB = 1024 * 1024;

function fileInfo(size: number): FileSystem.FileInfo {
  return { exists: true, uri: 'file:///doc.pdf', size, isDirectory: false, modificationTime: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResize.mockImplementation(async (uri) => ({ uri: `resized-${uri}`, ext: 'jpg' }));
  mockReadBase64.mockResolvedValue('QUJD');
  mockPrint.mockResolvedValue({ uri: 'file:///doc.pdf', numberOfPages: 1 });
  mockGetInfo.mockResolvedValue(fileInfo(1 * MB));
});

describe('routeScannedPages (single vs multi-page routing)', () => {
  it('returns null for zero pages (nothing to upload)', () => {
    expect(routeScannedPages([])).toBeNull();
  });

  it('routes a single page as a plain image upload', () => {
    expect(routeScannedPages(['file:///p1.jpg'])).toEqual({
      kind: 'image',
      uri: 'file:///p1.jpg',
    });
  });

  it('routes two or more pages as one PDF, preserving page order', () => {
    expect(routeScannedPages(['file:///p1.jpg', 'file:///p2.jpg'])).toEqual({
      kind: 'pdf',
      uris: ['file:///p1.jpg', 'file:///p2.jpg'],
    });
  });
});

describe('scanFileName', () => {
  it('formats as scan-YYYYMMDD-HHmm with zero padding', () => {
    expect(scanFileName('pdf', new Date(2026, 6, 6, 9, 5))).toBe('scan-20260706-0905.pdf');
    expect(scanFileName('jpg', new Date(2026, 11, 31, 23, 59))).toBe('scan-20261231-2359.jpg');
  });
});

describe('assemblePdf', () => {
  it('resizes every page at first-pass quality and embeds each as a data URI', async () => {
    const result = await assemblePdf(['file:///p1.jpg', 'file:///p2.jpg']);

    expect(result).toEqual({ uri: 'file:///doc.pdf', bytes: 1 * MB });
    expect(mockResize).toHaveBeenCalledTimes(2);
    expect(mockResize).toHaveBeenNthCalledWith(1, 'file:///p1.jpg', {
      maxEdge: 2000,
      quality: 0.8,
    });
    expect(mockResize).toHaveBeenNthCalledWith(2, 'file:///p2.jpg', {
      maxEdge: 2000,
      quality: 0.8,
    });
    expect(mockReadBase64).toHaveBeenCalledWith('resized-file:///p1.jpg', {
      encoding: 'base64',
    });

    expect(mockPrint).toHaveBeenCalledTimes(1);
    const html = mockPrint.mock.calls[0][0]?.html ?? '';
    // One sheet per page, fit-to-page, no margins.
    expect(html.match(/class="page"/g)).toHaveLength(2);
    expect(html.match(/data:image\/jpeg;base64,QUJD/g)).toHaveLength(2);
    expect(html).toContain('@page { margin: 0; }');
  });

  it('uses the right mime for non-jpeg pages', async () => {
    mockResize.mockImplementation(async (uri) => ({ uri: `resized-${uri}`, ext: 'png' }));
    await assemblePdf(['file:///p1.png', 'file:///p2.png']);
    const html = mockPrint.mock.calls[0][0]?.html ?? '';
    expect(html).toContain('data:image/png;base64,QUJD');
  });

  it('re-renders once at lower quality when the first PDF is over the cap', async () => {
    mockGetInfo.mockResolvedValueOnce(fileInfo(14.5 * MB)).mockResolvedValueOnce(fileInfo(6 * MB));

    const result = await assemblePdf(['file:///p1.jpg', 'file:///p2.jpg']);

    expect(result.bytes).toBe(6 * MB);
    expect(mockPrint).toHaveBeenCalledTimes(2);
    expect(mockResize).toHaveBeenCalledTimes(4);
    // Second pass drops to 1600 / 0.6.
    expect(mockResize).toHaveBeenNthCalledWith(3, 'file:///p1.jpg', {
      maxEdge: 1600,
      quality: 0.6,
    });
    expect(mockResize).toHaveBeenNthCalledWith(4, 'file:///p2.jpg', {
      maxEdge: 1600,
      quality: 0.6,
    });
  });

  it('throws PdfTooLargeError when even the retry is over the cap — exactly two renders', async () => {
    mockGetInfo.mockResolvedValue(fileInfo(20 * MB));

    await expect(assemblePdf(['file:///p1.jpg', 'file:///p2.jpg'])).rejects.toThrow(
      PdfTooLargeError,
    );
    expect(mockPrint).toHaveBeenCalledTimes(2);

    mockPrint.mockClear();
    mockGetInfo.mockResolvedValue(fileInfo(20 * MB));
    const err = await assemblePdf(['file:///p1.jpg']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfTooLargeError);
    expect((err as PdfTooLargeError).code).toBe('PDF_TOO_LARGE');
    expect((err as PdfTooLargeError).bytes).toBe(20 * MB);
  });

  it('accepts a PDF exactly at the cap (14 MB headroom under the 15 MB bucket limit)', async () => {
    mockGetInfo.mockResolvedValue(fileInfo(14 * MB));
    const result = await assemblePdf(['file:///p1.jpg']);
    expect(result.bytes).toBe(14 * MB);
    expect(mockPrint).toHaveBeenCalledTimes(1);
  });

  it('reports bytes 0 (caller falls back to buffer length) when sizing fails', async () => {
    mockGetInfo.mockResolvedValue({ exists: false, uri: 'file:///doc.pdf', isDirectory: false });
    const result = await assemblePdf(['file:///p1.jpg']);
    expect(result).toEqual({ uri: 'file:///doc.pdf', bytes: 0 });
  });
});

describe('scanDocumentPages (lazy native import)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function importWithScanner(
    scanDocument: (opts: unknown) => Promise<{ status?: string; scannedImages?: string[] }>,
  ) {
    vi.doMock('react-native-document-scanner-plugin', () => ({
      default: { scanDocument },
      ResponseType: { Base64: 'base64', ImageFilePath: 'imageFilePath' },
      ScanDocumentResponseStatus: { Success: 'success', Cancel: 'cancel' },
    }));
    return import('./document-scanner');
  }

  it("returns a typed 'unavailable' when the native module fails to load (old binary)", async () => {
    vi.doMock('react-native-document-scanner-plugin', () => {
      throw new Error("TurboModuleRegistry.getEnforcing('DocumentScanner'): module not found");
    });
    const { scanDocumentPages } = await import('./document-scanner');
    await expect(scanDocumentPages()).resolves.toEqual({ status: 'unavailable' });
  });

  it('returns the page URIs on success and passes the documented options', async () => {
    const scan = vi
      .fn()
      .mockResolvedValue({ status: 'success', scannedImages: ['file:///a.jpg', 'file:///b.jpg'] });
    const { scanDocumentPages } = await importWithScanner(scan);

    await expect(scanDocumentPages()).resolves.toEqual({
      status: 'success',
      pages: ['file:///a.jpg', 'file:///b.jpg'],
    });
    expect(scan).toHaveBeenCalledWith({ responseType: 'imageFilePath', maxNumDocuments: 10 });
  });

  it("returns 'cancelled' when the user closes the scanner", async () => {
    const { scanDocumentPages } = await importWithScanner(
      vi.fn().mockResolvedValue({ status: 'cancel' }),
    );
    await expect(scanDocumentPages()).resolves.toEqual({ status: 'cancelled' });
  });

  it("treats a success with zero pages as 'cancelled'", async () => {
    const { scanDocumentPages } = await importWithScanner(
      vi.fn().mockResolvedValue({ status: 'success', scannedImages: [] }),
    );
    await expect(scanDocumentPages()).resolves.toEqual({ status: 'cancelled' });
  });

  it("returns 'unavailable' when the scan call itself throws", async () => {
    const { scanDocumentPages } = await importWithScanner(
      vi.fn().mockRejectedValue(new Error('camera unavailable')),
    );
    await expect(scanDocumentPages()).resolves.toEqual({ status: 'unavailable' });
  });
});
