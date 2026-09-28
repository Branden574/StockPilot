import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORG } from './__fixtures__/book-order-totals';
import { endAccountEpoch } from './account-epoch';
import { describeBookReportError } from './book-order-totals-api';
import { CONNECTION_FAILURE_COPY } from './connection-copy';
import { abortAllInFlight, inFlightCount } from './request-cancellation';
import {
  REPORT_EXPORT_DIR_NAME,
  REPORT_EXPORT_ERROR_BYTES,
  REPORT_EXPORT_SESSION_CHANGED,
  REPORT_EXPORT_SHARE_UNAVAILABLE,
  REPORT_EXPORT_STOPPED,
  REPORT_EXPORT_TIMED_OUT,
  ReportExportError,
  downloadReportFile,
  exportAndShareReport,
  exportFileName,
  parseExportRefusal,
  retryAfterSeconds,
} from './report-export-download';

/**
 * The export download (plan 9.5): the Bearer token AND the report's
 * workspace header on the request (org-header-wiring.test.ts scans only
 * app/, so this pins the helper), a refusal that deletes the file and is
 * worded like any other, a timeout that cancels, and iOS-only sharing.
 */

const fsMock = vi.hoisted(() => ({
  cacheDirectory: 'file:///cache/' as string | null,
  createDownloadResumable: vi.fn(),
  deleteAsync: vi.fn(async (_uri: string, _opts?: unknown) => undefined),
  makeDirectoryAsync: vi.fn(async (_uri: string, _opts?: unknown) => undefined),
  moveAsync: vi.fn(async (_opts: { from: string; to: string }) => undefined),
  readAsStringAsync: vi.fn(async (_uri: string, _opts?: unknown) => ''),
}));
vi.mock('expo-file-system/legacy', () => fsMock);

const rnMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as string },
  Share: { share: vi.fn(async () => ({ action: 'sharedAction' })) },
}));
vi.mock('react-native', () => rnMock);

vi.mock('./api', () => ({ API_BASE: 'https://api.test' }));

const sessionMock = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok-123' } } })),
}));
vi.mock('./supabase', () => ({ supabase: { auth: sessionMock } }));

const evictionMock = vi.hoisted(() => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./account-eviction', () => evictionMock);

type Result = { status: number; headers: Record<string, string>; uri: string; mimeType: null } | undefined;

/** A download task whose answer the test decides. `hang` never settles until
 *  cancelled (then it resolves undefined, as expo-file-system does). */
function task(answer: Result | 'hang' | 'throw') {
  let cancel: () => void = () => undefined;
  const t = {
    downloadAsync: vi.fn(
      () =>
        new Promise<Result>((resolve, reject) => {
          if (answer === 'hang') cancel = () => resolve(undefined);
          else if (answer === 'throw') reject(new Error('fetch failed: UnexpectedException'));
          else resolve(answer);
        }),
    ),
    cancelAsync: vi.fn(async () => cancel()),
  };
  fsMock.createDownloadResumable.mockImplementationOnce((_url: string, uri: string) => {
    if (answer && answer !== 'hang' && answer !== 'throw') answer.uri = uri;
    return t;
  });
  return t;
}

const req = {
  path: '/api/v1/reports/book-order-totals/export?format=csv&warehouse=all',
  orgId: ORG,
  format: 'csv' as const,
  fallbackName: 'book-order-totals',
};

beforeEach(() => {
  vi.clearAllMocks();
  rnMock.Platform.OS = 'ios';
  fsMock.cacheDirectory = 'file:///cache/';
  sessionMock.getSession.mockImplementation(async () => ({
    data: { session: { access_token: 'tok-123' } },
  }));
  abortAllInFlight();
});

describe('downloadReportFile', () => {
  it('sends the Bearer token and the REPORT’s workspace, to the API origin', async () => {
    task({
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="book-order-totals_2026-09-28.csv"' },
      uri: '',
      mimeType: null,
    });
    const file = await downloadReportFile(req);
    const [url, , options] = fsMock.createDownloadResumable.mock.calls[0]!;
    expect(url).toBe(`https://api.test${req.path}`);
    expect(options).toEqual({
      headers: { Authorization: 'Bearer tok-123', 'X-Organization-Id': ORG },
    });
    expect(file.filename).toBe('book-order-totals_2026-09-28.csv');
    expect(file.uri).toBe(`file:///cache/${REPORT_EXPORT_DIR_NAME}book-order-totals_2026-09-28.csv`);
    expect(fsMock.moveAsync).toHaveBeenCalledTimes(1);
    // Only the last export stays on the phone: the folder is emptied first.
    expect(fsMock.deleteAsync).toHaveBeenCalledWith(`file:///cache/${REPORT_EXPORT_DIR_NAME}`, {
      idempotent: true,
    });
    expect(inFlightCount()).toBe(0);
  });

  it('a refusal reads at most 4 KB, deletes the file and throws the route’s error', async () => {
    task({
      status: 400,
      headers: {},
      uri: '',
      mimeType: null,
    });
    fsMock.readAsStringAsync.mockResolvedValueOnce(
      JSON.stringify({
        error: 'validation_error',
        message: 'Too many books for one file (21,340; the limit is 20,000). Narrow the filters.',
        details: { reason: 'too_many_rows', count: 21340, limit: 20000 },
      }),
    );
    const e = await downloadReportFile(req).catch((x) => x);
    expect(e).toBeInstanceOf(ReportExportError);
    expect(e).toMatchObject({ status: 400, code: 'validation_error' });
    expect(fsMock.readAsStringAsync.mock.calls[0]![1]).toEqual({
      position: 0,
      length: REPORT_EXPORT_ERROR_BYTES,
    });
    const temp = fsMock.readAsStringAsync.mock.calls[0]![0];
    expect(fsMock.deleteAsync).toHaveBeenCalledWith(temp, { idempotent: true });
    expect(describeBookReportError(e, 'export').detail).toBe(
      'Too many books for one file (21,340; the limit is 20,000). Narrow the filters.',
    );
  });

  it('a 401 asks the account gate for a probe, as api() does', async () => {
    task({ status: 401, headers: {}, uri: '', mimeType: null });
    fsMock.readAsStringAsync.mockResolvedValueOnce('{"error":"unauthenticated","message":"Your session ended. Sign in again."}');
    await expect(downloadReportFile(req)).rejects.toMatchObject({ status: 401 });
    expect(evictionMock.notifyUnauthorized).toHaveBeenCalledWith({ status: 401 });
  });

  it('a 429 carries Retry-After', async () => {
    task({ status: 429, headers: { 'retry-after': '600' }, uri: '', mimeType: null });
    fsMock.readAsStringAsync.mockResolvedValueOnce('{"error":"rate_limited","message":"Too many exports"}');
    const e = await downloadReportFile(req).catch((x) => x);
    expect(e.retryAfterSeconds).toBe(600);
    expect(describeBookReportError(e, 'export').detail).toBe(
      'Too many exports in the last hour. Try again in 10 minutes.',
    );
  });

  it('a stalled download is cancelled at the timeout and its partial file deleted', async () => {
    const t = task('hang');
    const e = await downloadReportFile(req, { timeoutMs: 5 }).catch((x) => x);
    expect(t.cancelAsync).toHaveBeenCalledTimes(1);
    expect(e).toMatchObject({ message: REPORT_EXPORT_TIMED_OUT, status: null });
    expect(fsMock.deleteAsync).toHaveBeenCalledTimes(2); // the folder, then the partial file
    expect(inFlightCount()).toBe(0);
  });

  it('an account eviction cancels a download on the wire', async () => {
    const t = task('hang');
    const pending = downloadReportFile(req).catch((x) => x);
    await vi.waitFor(() => expect(inFlightCount()).toBe(1));
    abortAllInFlight();
    const e = await pending;
    expect(t.cancelAsync).toHaveBeenCalledTimes(1);
    expect(e).toMatchObject({ message: REPORT_EXPORT_STOPPED });
  });

  it('no answer at all is the connection, in the app’s words', async () => {
    task('throw');
    const e = await downloadReportFile(req).catch((x) => x);
    expect(e).toMatchObject({ status: null, message: CONNECTION_FAILURE_COPY });
    expect(describeBookReportError(e, 'export').detail).toBe(CONNECTION_FAILURE_COPY);
  });

  it('a file that lands after the account changed is deleted, never kept', async () => {
    const t = {
      downloadAsync: vi.fn(async () => {
        endAccountEpoch();
        return { status: 200, headers: {}, uri: 'x', mimeType: null };
      }),
      cancelAsync: vi.fn(async () => undefined),
    };
    fsMock.createDownloadResumable.mockImplementationOnce(() => t);
    await expect(downloadReportFile(req)).rejects.toMatchObject({ message: REPORT_EXPORT_SESSION_CHANGED });
  });

  it('without a session it never sends', async () => {
    sessionMock.getSession.mockImplementationOnce(async () => ({ data: { session: null } }) as never);
    await expect(downloadReportFile(req)).rejects.toMatchObject({ status: 401 });
    expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
  });
});

describe('exportAndShareReport', () => {
  it('iOS: downloads, then shares the FILE (url) through the share sheet', async () => {
    task({ status: 200, headers: {}, uri: '', mimeType: null });
    await exportAndShareReport({ ...req, title: 'Book Order Totals' });
    expect(rnMock.Share.share).toHaveBeenCalledTimes(1);
    const [content] = rnMock.Share.share.mock.calls[0]! as unknown as [{ url: string; title: string }];
    expect(content.url).toMatch(/^file:\/\/\/cache\/report-exports\/book-order-totals\.csv$/);
    expect(content.title).toBe('Book Order Totals');
  });

  it('Android: refuses before any download and never calls Share (it would send a bare path)', async () => {
    rnMock.Platform.OS = 'android';
    await expect(exportAndShareReport({ ...req, title: 'Book Order Totals' })).rejects.toMatchObject({
      message: REPORT_EXPORT_SHARE_UNAVAILABLE,
    });
    expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
    expect(rnMock.Share.share).not.toHaveBeenCalled();
  });

  it('a refused export is never shared', async () => {
    task({ status: 403, headers: {}, uri: '', mimeType: null });
    fsMock.readAsStringAsync.mockResolvedValueOnce('{"error":"forbidden","message":"Missing permission: reports:export"}');
    await expect(exportAndShareReport({ ...req, title: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(rnMock.Share.share).not.toHaveBeenCalled();
  });
});

describe('small helpers', () => {
  it('file names are reduced to safe characters and the export’s extension', () => {
    expect(exportFileName('attachment; filename="book-order-totals_2026-09-28.csv"', 'csv', 'x')).toBe(
      'book-order-totals_2026-09-28.csv',
    );
    expect(exportFileName('inline; filename="../../etc/passwd"', 'pdf', 'x')).toBe('etc-passwd.pdf');
    expect(exportFileName(null, 'pdf', 'book-order-totals')).toBe('book-order-totals.pdf');
    expect(exportFileName('attachment; filename="a.exe"', 'csv', 'x')).toBe('a.csv');
  });
  it('Retry-After seconds', () => {
    expect(retryAfterSeconds('120')).toBe(120);
    expect(retryAfterSeconds('soon')).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });
  it('a refusal that is not our JSON still reads as a sentence', () => {
    expect(parseExportRefusal(502, '<html>bad gateway</html>', null).message).toBe(
      'The export was refused (502).',
    );
  });
});
