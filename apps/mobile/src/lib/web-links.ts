import { API_BASE } from './api';

/**
 * A link to a page of the web app, on the host this build talks to (B124).
 *
 * The phone's "open on the web" links named https://stockpilotusa.com
 * themselves, so a lab, preview or development build opened production
 * pages. They are built here from the same host the API requests use
 * (api-host.ts): the web app serves both. A production build resolves it to
 * https://stockpilotusa.com, so it opens the same addresses as before
 * (web-links.test.ts). Nothing is added to the path: no query, no token, no
 * identifier beyond the record id a caller already put in it.
 */
export function webLink(webPath: `/${string}`, base: string = API_BASE): string {
  return `${base.replace(/\/+$/, '')}${webPath}`;
}
