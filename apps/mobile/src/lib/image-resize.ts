import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

/**
 * Resize a photo so the longest edge is at most `maxEdge` pixels,
 * re-encoded as JPEG at the given quality. Returns the new file URI
 * (a temp path in the app's cache) and the new extension.
 *
 * Why: phone camera shots are typically 4000×3000 (~3–5 MB JPEG).
 * For inventory thumbnails + reasonable detail views, anything beyond
 * 1600 on the longest edge is invisible and just makes the list lag
 * during fast scroll. Resizing pre-upload shrinks new photos to
 * ~300–500 KB which the list can decode in <5 ms instead of 100+ ms.
 *
 * Aspect ratio is preserved. If the source is already small enough
 * we skip manipulation entirely and return the input untouched.
 */
export async function resizeForUpload(
  uri: string,
  options: { maxEdge?: number; quality?: number } = {},
): Promise<{ uri: string; ext: string }> {
  const maxEdge = options.maxEdge ?? 1600;
  const quality = options.quality ?? 0.85;

  // Probe original dimensions. Image.getSize is async + callback-style.
  const dims = await new Promise<{ width: number; height: number } | null>((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      // If sizing fails (e.g. HEIC variant the OS won't decode synchronously)
      // just fall through and let the manipulator handle it.
      () => resolve(null),
    );
  });

  // Already small enough — skip the resize pass, BUT only keep the original
  // bytes when the source is a web-decodable format. iOS hands back HEIC/HEIF
  // by default, which no mainstream browser can render — so a small HEIC left
  // as-is uploads fine but shows as a broken image on the web (e.g. an order
  // proof photo a manager reviews). For those, transcode to JPEG (no resize)
  // so the stored object is always browser-decodable.
  if (dims && dims.width <= maxEdge && dims.height <= maxEdge) {
    const ext = (uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
    const WEB_SAFE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
    if (WEB_SAFE.has(ext)) {
      return { uri, ext: ext === 'jpeg' ? 'jpg' : ext };
    }
    const converted = await ImageManipulator.manipulateAsync(uri, [], {
      compress: quality,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return { uri: converted.uri, ext: 'jpg' };
  }

  // Compute new size: longer edge clamped to maxEdge, aspect preserved.
  // When dims probe failed, target width=maxEdge — the manipulator keeps
  // aspect ratio when only one dimension is given.
  const resize = dims
    ? dims.width >= dims.height
      ? { width: maxEdge, height: Math.round((dims.height / dims.width) * maxEdge) }
      : { height: maxEdge, width: Math.round((dims.width / dims.height) * maxEdge) }
    : { width: maxEdge };

  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize }],
    { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
  );
  return { uri: result.uri, ext: 'jpg' };
}
