/**
 * Multipart/form-data uploads that survive Expo SDK 56+.
 *
 * WHY THIS MODULE EXISTS
 * Since SDK 56 Expo REPLACES the global `fetch` with its own `expo/fetch`
 * (expo/src/winter/runtime.native.ts — `install('fetch', …)` unless
 * EXPO_PUBLIC_USE_RN_FETCH is set). That implementation refuses React
 * Native's proprietary `{ uri, name, type }` FormData file part, which every
 * multipart upload in this app used:
 *
 *   * expo/src/winter/fetch/convertFormData.ts:35 — "`uri` is not supported
 *     for React Native's FormData."
 *   * :44-52 — the RN `getParts()` bridge maps a `{uri}` part to
 *     `part.file`, i.e. `undefined`. (Not even reached here: Expo's own
 *     FormData patch installs an `entries()` generator on RN's prototype, so
 *     the `typeof formData.entries !== 'function'` branch is skipped and the
 *     raw `{uri, name, type}` object is yielded as the entry.)
 *   * :70-77 — a `{uri}` entry is not a string, not a `Blob`, and has no
 *     `bytes`, so serialization THROWS `Unsupported FormDataPart
 *     implementation` at request-build time — before any network I/O.
 *
 * So the failure was total and offline: PO scan, cycle-count AI scan,
 * size-count training capture and the AI chat photo attach all died on the
 * first tap while the same flows kept working on web.
 *
 * WHY WE BUILD THE BODY OURSELVES
 * We serialize the multipart body to bytes here and hand `fetch` a plain
 * `Uint8Array` plus an explicit `Content-Type` boundary header. That is
 * accepted by BOTH transports, so the fix does not depend on which `fetch` is
 * installed:
 *   * expo/fetch — `normalizeBodyInitAsync` takes the `ArrayBuffer.isView`
 *     branch (RequestUtils.ts) and passes the bytes through untouched,
 *     keeping our Content-Type.
 *   * RN's fetch (the EXPO_PUBLIC_USE_RN_FETCH escape hatch) —
 *     `convertRequestBody` takes the same `ArrayBuffer.isView` branch and
 *     base64-bridges the bytes to native.
 * Handing Expo a `bytes`-bearing part object instead would work today but
 * leans on an undocumented internal shape (convertFormData.ts:73) AND lets
 * Expo pick the filename encoding (`encodeFilename` percent-escapes it) and
 * the part's content type — the two fields these server routes validate. We
 * need those byte-exact, so we own them.
 *
 * `new TextEncoder()` is safe to use unconditionally: it is a Hermes builtin
 * (see the comment at the top of expo/src/winter/TextDecoder.ts, "TextEncoder
 * is in Hermes"), which is also why Expo's own serializer uses it bare.
 *
 * MEMORY POSTURE
 * The whole body is buffered in JS, so callers MUST resize/compress before
 * calling — every current call site already does (resizeForUpload /
 * ImageManipulator). A 5-frame PO scan at 2000px/q0.82 is ~0.5-1 MB per frame,
 * so ~10 MB peak including the concatenated copy: fine. Never pass un-resized
 * camera originals (4-10 MB each) through here.
 *
 * NOT expo-file-system's UploadType.MULTIPART: it streams off disk (nicer) but
 * carries exactly ONE file per request (`fieldName` is singular — see
 * expo-file-system/build/NetworkTasks.types.d.ts `UploadOptions`), and
 * /api/po-imports/scan needs N `file` parts in ONE request to combine pages of
 * a single PO. One helper for all four call sites beats two transports.
 */
import { File as FsFile } from 'expo-file-system';

/** One file part. `fileName` and `contentType` land on the wire verbatim —
 *  server routes validate exactly these (e.g. /api/po-imports/scan checks
 *  `f.type` against its allowlist and reports `f.name`). */
export type MultipartFilePart = {
  /** Form field name. Repeat the same name to send several files under it. */
  field: string;
  /** Local file uri (file://…). Read to bytes right before the request. */
  uri: string;
  fileName: string;
  contentType: string;
};

/** One plain text field, appended after the files (the order the previous
 *  FormData call sites used, kept so nothing about the wire order changes). */
export type MultipartTextField = { name: string; value: string };

export type MultipartBody = {
  /** The serialized body, ready to pass as `fetch`'s `body`. The explicit
   *  `<ArrayBuffer>` argument is what makes it a `BufferSource`, and therefore
   *  a legal `BodyInit` — the default `Uint8Array<ArrayBufferLike>` is not. */
  body: Uint8Array<ArrayBuffer>;
  /** The exact `Content-Type` header value, boundary included. */
  contentType: string;
};

/** Reads a local file to bytes. Injectable so the body builder is unit
 *  testable without a filesystem or a native module. */
export type FileByteReader = (uri: string) => Promise<Uint8Array>;

/**
 * Default reader: expo-file-system's NEW File API, whose native `bytes()`
 * hands back a `Uint8Array` directly (FileSystemModule.swift:161 /
 * FileSystemModule.kt:175 in expo-file-system 57).
 *
 * Deliberately NOT `readAsStringAsync(…, Base64)` + a decode: that inflates
 * the file to a ~1.33x base64 string on top of the decoded copy, and needs a
 * hand-rolled decoder (Hermes has no `atob`). Deliberately NOT
 * `fetch(uri).blob()` either — the documented Expo landmine that uploads
 * 0 bytes, and the native blob read behind a production EXC_BAD_ACCESS
 * (Sentry a8109a24).
 *
 * NOTE the import is the bare `expo-file-system`, not `/legacy`: this is the
 * new API, the one the `/legacy` split moved TOWARDS. The `/legacy` warning
 * that other modules here carry applies to the URI-string functions
 * (createUploadTask / readAsStringAsync / getInfoAsync) only.
 */
export const readFileBytes: FileByteReader = async (uri) => new FsFile(uri).bytes();

const BOUNDARY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh boundary token. 32 random chars makes an accidental collision with
 *  file bytes irrelevant, which is the same bet every browser makes. */
export function createMultipartBoundary(): string {
  let boundary = '----StockPilotFormBoundary';
  for (let i = 0; i < 32; i++) {
    boundary += BOUNDARY_CHARS.charAt(Math.floor(Math.random() * BOUNDARY_CHARS.length));
  }
  return boundary;
}

/**
 * Escape a field name / filename for a quoted Content-Disposition parameter
 * EXACTLY the way the WHATWG FormData serializer (i.e. every browser, i.e.
 * the web upload paths these routes already serve) does: only CR, LF and the
 * double quote are percent-escaped, everything else — including non-ASCII —
 * goes out as raw UTF-8.
 *
 * This is the header-injection guard as well as a compatibility choice:
 * filenames reach us from the image picker (`asset.fileName`), so a name
 * carrying a quote or newline must not be able to forge a part header.
 */
/**
 * A part's Content-Type reaches this builder from the same trust tier as the
 * filename (OS/picker-derived — e.g. expo-image-picker's asset.mimeType), so
 * it gets the same treatment: anything that is not a plain `type/subtype`
 * token is replaced rather than interpolated into the header block, which
 * would otherwise let a CR/LF forge additional headers or part boundaries.
 */
function safeContentType(value: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
}

function escapeDispositionValue(value: string): string {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}

/**
 * Serialize files + text fields into a multipart/form-data body (RFC 7578).
 *
 * Part order is FILES first (in the given order — `/api/po-imports/scan` reads
 * `form.getAll('file')` and treats that order as page order), then text
 * fields. Every file part carries a `filename`, which is what makes the server
 * see a `File`/`Blob` rather than a string: undici's parser (behind Next.js's
 * `req.formData()`) only mints a File when `filename` is present, and the
 * routes here all gate on `instanceof File` / `instanceof Blob`.
 */
export async function buildMultipartBody(args: {
  files: MultipartFilePart[];
  fields?: MultipartTextField[];
  /** Injected in tests to pin the wire format; production omits it. */
  boundary?: string;
  readBytes?: FileByteReader;
}): Promise<MultipartBody> {
  const boundary = args.boundary ?? createMultipartBoundary();
  const readBytes = args.readBytes ?? readFileBytes;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const file of args.files) {
    const bytes = await readBytes(file.uri);
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeDispositionValue(file.field)}"; ` +
          `filename="${escapeDispositionValue(file.fileName)}"\r\n` +
          `Content-Type: ${safeContentType(file.contentType)}\r\n\r\n`,
      ),
    );
    chunks.push(bytes);
    chunks.push(encoder.encode('\r\n'));
  }

  for (const field of args.fields ?? []) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeDispositionValue(field.name)}"\r\n\r\n` +
          `${field.value}\r\n`,
      ),
    );
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * POST a multipart/form-data request. Returns the raw `Response` so callers
 * keep their own status handling, body parsing and error copy untouched.
 *
 * `Content-Type` is set here and CANNOT be overridden by `headers` — a caller
 * supplying one would break the boundary and every part would be lost. Other
 * headers (Authorization above all) pass through as given.
 */
export async function postMultipart(
  url: string,
  args: {
    files: MultipartFilePart[];
    fields?: MultipartTextField[];
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Test seams; production omits both. */
    boundary?: string;
    readBytes?: FileByteReader;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  const { body, contentType } = await buildMultipartBody({
    files: args.files,
    fields: args.fields,
    boundary: args.boundary,
    readBytes: args.readBytes,
  });
  const doFetch = args.fetchImpl ?? fetch;
  return doFetch(url, {
    method: 'POST',
    headers: { ...args.headers, 'Content-Type': contentType },
    body,
    signal: args.signal,
  });
}
