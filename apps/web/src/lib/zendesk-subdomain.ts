/**
 * The one check for a Zendesk subdomain: a single DNS label (letters, digits
 * and inner hyphens, at most 63 characters), with no `.`, `/`, `:`, `@`, `#`,
 * `?` or whitespace. The value is put in front of `.zendesk.com` to build a
 * host, so anything else could name another host.
 *
 * The connect and subdomain saves refuse anything else before they write
 * (server/services/connections.ts), the API client refuses it before any
 * request (server/connectors/zendesk/client.ts), and the Zendesk page builds
 * its link and its "Connected to ..." text only from a stored value that
 * passes it, reading any other value as not set (docket S27). Plain module:
 * the page, its client components and the server import it alike.
 */
const ZENDESK_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isZendeskSubdomain(value: string | null | undefined): value is string {
  return typeof value === 'string' && ZENDESK_SUBDOMAIN.test(value);
}
