import { verifyConfirmRecipient } from '@/lib/auth/confirm-link';

/**
 * The /auth/confirm link an email carries, read the way the route reads it,
 * and whom its `r` names by the app's own checker (docket S25). For the link
 * builders' suites: only GoTrue is mocked there, so this proves the link a
 * person would receive names the account GoTrue made it for.
 *
 * Reads the email's TEXT part, which carries the link as written; the HTML
 * part escapes its `&`.
 */
export interface EmailedConfirmLink {
  url: URL;
  tokenHash: string | null;
  type: string | null;
  next: string | null;
  r: string | null;
  /** The account `r` names, or null when it does not check out. */
  recipient: string | null;
}

export function emailedConfirmLink(text: string): EmailedConfirmLink {
  const found = text.match(/https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/g) ?? [];
  if (found.length !== 1) {
    throw new Error(`expected one confirmation link in the email text, found ${found.length}`);
  }
  const url = new URL(found[0]!);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const r = url.searchParams.get('r');
  const verdict =
    tokenHash && type && r !== null ? verifyConfirmRecipient({ type, tokenHash, r }) : null;
  return {
    url,
    tokenHash,
    type,
    next: url.searchParams.get('next'),
    r,
    recipient: verdict?.status === 'valid' ? verdict.userId : null,
  };
}
