/**
 * The largest body a public form post takes (order requests, return requests,
 * return options). The largest real one, an order of 100 lines with notes, is
 * a small fraction of it.
 */
export const PUBLIC_FORM_BODY_LIMIT = 256 * 1024;

/** The answer of a public form post whose body is over its limit. */
export const PAYLOAD_TOO_LARGE = {
  error: 'payload_too_large',
  message: 'This form is too large to send.',
} as const;

export type LimitedJson =
  { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'invalid_json' };

/**
 * A request's JSON body, read only up to `maxBytes`.
 *
 * A declared Content-Length over the limit is refused before any byte is read.
 * Otherwise the body is read with a byte count and refused as soon as it passes
 * the limit, which also covers a chunked body with no declared length and a
 * declared length that is wrong. Only a body within the limit is parsed, as
 * UTF-8 the way Request.json() reads it.
 */
export async function readJsonLimited(req: Request, maxBytes: number): Promise<LimitedJson> {
  const declared = req.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= maxBytes)) {
    return { ok: false, reason: 'too_large' };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          reader.cancel().catch(() => {});
          return { ok: false, reason: 'too_large' };
        }
        chunks.push(value);
      }
    } catch {
      // A body that breaks off is refused like one that is not JSON, as
      // Request.json() refuses it.
      return { ok: false, reason: 'invalid_json' };
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
