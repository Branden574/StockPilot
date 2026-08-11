import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest of a public/share bearer token — THE at-rest form of
 * every /r and /m credential since migration 0330 (security MED-26). The
 * database stores only this digest (public_request_links.token_hash,
 * maintenance_request_share_links.token_hash,
 * organizations.public_request_token_hash); resolution hashes the presented
 * plaintext server-side and compares equality on the hash column.
 *
 * Unsalted on purpose: every token is 64 hex chars minted from 32 CSPRNG
 * bytes, so an offline attacker with the digests cannot enumerate the
 * preimage space — a salt/pepper would add operational surface (a secret to
 * rotate) without adding protection for 256-bit random inputs. Same
 * reasoning as 0108's order_requests.confirmation_token_hash, whose
 * createHash('sha256') convention this helper is.
 *
 * A timing-safe comparison is deliberately NOT used at the resolution
 * sites: the comparison happens inside Postgres' btree index lookup, whose
 * timing an anonymous HTTP caller cannot measure through connection
 * pooling, network jitter, and the query planner — and the input is itself
 * a 256-bit random value, so there is no low-entropy secret for a timing
 * oracle to whittle down. (This mirrors how /r/confirm already compares
 * confirmation_token_hash.)
 */
export function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
