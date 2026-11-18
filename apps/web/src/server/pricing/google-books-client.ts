import 'server-only';

import { env } from '@/lib/env';

export interface GoogleBooksClient {
  /**
   * Google's answer for one ISBN: the parsed JSON, which may hold no volume
   * or no price (a real "no price found"). Throws GoogleBooksUnavailableError
   * when Google did not answer: a rate limit (429), any other non-200, or no
   * reply at all. That is not "no price", and the caller must not record it
   * as one.
   */
  fetchVolumeByIsbn(isbn: string): Promise<unknown | null>;
}

/** Google Books did not answer (see GoogleBooksClient). `status`: the HTTP
 *  status, or null when no reply came. */
export class GoogleBooksUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(
      status === null ? 'Google Books could not be reached' : `Google Books answered ${status}`,
    );
    this.name = 'GoogleBooksUnavailableError';
  }
}

/**
 * Stateless Google Books client. Free endpoint; `country=US` so saleInfo
 * prices are returned; optional API key (env.GOOGLE_BOOKS_API_KEY) raises
 * quota. Returns the parsed JSON, and throws GoogleBooksUnavailableError on
 * any non-200 (incl. 429) or a failed fetch.
 */
export const googleBooksClient: GoogleBooksClient = {
  async fetchVolumeByIsbn(isbn: string): Promise<unknown | null> {
    const digits = isbn.replace(/[\s-]/g, '');
    const params = new URLSearchParams({ q: `isbn:${digits}`, country: 'US' });
    if (env.GOOGLE_BOOKS_API_KEY) params.set('key', env.GOOGLE_BOOKS_API_KEY);
    let res: Response;
    try {
      res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
    } catch (e) {
      console.warn('[google-books] fetch failed', e);
      throw new GoogleBooksUnavailableError(null);
    }
    if (!res.ok) {
      console.warn(`[google-books] ${res.status} for isbn ${digits}`);
      throw new GoogleBooksUnavailableError(res.status);
    }
    try {
      return (await res.json()) as unknown;
    } catch (e) {
      // A 200 whose body is not JSON: Google did not really answer either.
      console.warn('[google-books] unreadable reply', e);
      throw new GoogleBooksUnavailableError(res.status);
    }
  },
};
