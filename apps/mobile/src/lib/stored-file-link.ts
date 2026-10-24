/**
 * Opening a stored file from a signed link that may have expired: an order's
 * proof of delivery (app/order/[id].tsx) and a purchase order's attachments
 * (components/po-attachments.tsx).
 *
 * THE DEFECT. Both sign every file's link for one hour when their list loads
 * (createSignedUrls(paths, 3600)), and a tap opened whatever link the list
 * held. The order screen signs again only when it regains focus or is pulled
 * to refresh, and the purchase order card only when it mounts. So a screen
 * left open for an hour, or brought back from the background, opened an
 * expired link: a PDF opened on the storage service's error, and a photo that
 * was not already in the image cache never appeared. The purchase order card
 * then said "Pull to refresh and try again", on a screen that has no pull to
 * refresh.
 *
 * THE RULE. A link is used while it has more than five minutes left. Past
 * that, or with no link at all, the file is signed again at the tap, for the
 * same hour, and that link is opened (the screen keeps it for the next tap).
 * Signing reads the file through the caller's own storage access, exactly as
 * the list's signing did, so it opens nothing the list could not.
 */

/** How long a stored file's signed link lasts: one hour, as before. */
export const STORED_FILE_LINK_SECONDS = 60 * 60;

/** A link with less than this left is signed again before it is opened. */
const SAFETY_MS = 5 * 60 * 1000;

/** A link as a screen holds it, with when it was signed (ms since epoch). */
export interface HeldLink {
  url: string | null;
  signedAt: number | null;
}

/** True while `link` has more than five minutes of its hour left at `now`. */
export function linkIsFresh(link: HeldLink, now: number): boolean {
  return (
    link.url !== null &&
    link.signedAt !== null &&
    now < link.signedAt + STORED_FILE_LINK_SECONDS * 1000 - SAFETY_MS
  );
}

/**
 * The link to open: the held one while it is fresh, else one signed now.
 * `resigned` says the caller should keep the new link. Null when there is no
 * fresh link and signing failed (offline, or the storage service refused).
 */
export async function linkToOpen(
  link: HeldLink,
  sign: () => Promise<string | null>,
  now: () => number = Date.now,
): Promise<{ url: string; signedAt: number; resigned: boolean } | null> {
  const startedAt = now();
  if (linkIsFresh(link, startedAt)) {
    return { url: link.url as string, signedAt: link.signedAt as number, resigned: false };
  }
  let url: string | null = null;
  try {
    url = await sign();
  } catch {
    url = null;
  }
  // Timed from before the request, so the link is never thought to last
  // longer than it does.
  return url ? { url, signedAt: startedAt, resigned: true } : null;
}

/** The part of the Supabase storage client this needs. */
export interface StorageSigner {
  from(bucket: string): {
    createSignedUrl(
      path: string,
      expiresIn: number,
    ): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
  };
}

/** Signs one object of `bucket` for STORED_FILE_LINK_SECONDS; null on any failure. */
export function signerFor(
  storage: StorageSigner,
  bucket: string,
  path: string,
): () => Promise<string | null> {
  return async () => {
    const { data, error } = await storage
      .from(bucket)
      .createSignedUrl(path, STORED_FILE_LINK_SECONDS);
    return error || !data?.signedUrl ? null : data.signedUrl;
  };
}
